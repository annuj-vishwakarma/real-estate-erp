import { Types, type ClientSession } from 'mongoose';
import {
  applyBasisPoints,
  canTransitionBooking,
  financialYear,
  generateSchedule,
  parseISODate,
  priceForArea,
  todayInIndia,
  type BookingStatus,
  type CancelBookingInput,
  type CreateBookingInput,
  type PaymentPlanRule,
  type QuoteInput,
} from '@erp/shared';
import { nextSequence } from '../../db/system.models';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../utils/audit';
import { logger } from '../../utils/logger';
import { AppError, badRequest, businessRule, forbidden, notFound } from '../../utils/errors';
import { escapeRegex, pageMeta, parseSort } from '../../utils/http';
import { assertProjectAccess, hasPermission, scopedFilter, toObjectId, type TenantContext } from '../../utils/tenant';
import { postJournal, reverseJournal } from '../accounting/ledger.service';
import { accrueCommission, cancelCommission } from '../brokers/brokers.service';
import { Company } from '../companies/company.model';
import { Broker, Customer } from '../customers/customer.models';
import { assertCustomerVisible } from '../customers/customers.service';
import { Payment } from '../payments/payment.models';
import { Plot } from '../plots/plot.models';
import { recordPlotStatus } from '../plots/plots.service';
import { Block, Project } from '../projects/project.models';
import { Booking, BookingItem, Installment, PaymentPlan } from './booking.models';

type Actor = Pick<TenantContext, 'companyId' | 'userId' | 'meta'>;

interface PricedItem {
  plotId: Types.ObjectId;
  plotNumber: string;
  blockCode?: string;
  areaX100: number;
  ratePaisePerSqft: number;
  plcBp: number;
  basePaise: number;
  plcPaise: number;
  lineTotalPaise: number;
}

async function loadPlan(ctx: TenantContext, planId: string, projectId: Types.ObjectId, session?: ClientSession) {
  const plan = await PaymentPlan.findOne({ companyId: ctx.companyId, _id: toObjectId(planId), isActive: true })
    .session(session ?? null)
    .lean();
  if (!plan) throw badRequest('Payment plan not found or inactive');
  if (plan.projectId && String(plan.projectId) !== String(projectId)) throw badRequest('Payment plan is not available for this project');
  return plan;
}

/** Prices plots and builds the schedule. Shared by quotations and booking creation. */
async function priceBooking(ctx: TenantContext, input: QuoteInput, session?: ClientSession) {
  assertProjectAccess(ctx, input.projectId);
  const projectId = toObjectId(input.projectId);
  const project = await Project.findOne({ companyId: ctx.companyId, _id: projectId })
    .session(session ?? null)
    .lean();
  if (!project) throw notFound('Project');
  if (project.status === 'archived') throw businessRule('Project is archived');

  const plotIds = [...new Set(input.plotIds)].map(toObjectId);
  if (plotIds.length !== input.plotIds.length) throw badRequest('Duplicate plots selected');
  const plots = await Plot.find({ companyId: ctx.companyId, projectId, _id: { $in: plotIds }, deletedAt: null })
    .session(session ?? null)
    .lean();
  if (plots.length !== plotIds.length) throw badRequest('One or more plots do not belong to this project');

  const blocks = await Block.find({ companyId: ctx.companyId, projectId })
    .session(session ?? null)
    .select('code')
    .lean();
  const blockCode = new Map(blocks.map((b) => [String(b._id), b.code]));

  const items: PricedItem[] = plots.map((p) => {
    const basePaise = priceForArea(p.areaX100, p.ratePaisePerSqft);
    const plcPaise = applyBasisPoints(basePaise, p.plcBp);
    return {
      plotId: p._id,
      plotNumber: p.plotNumber,
      blockCode: p.blockId ? blockCode.get(String(p.blockId)) : undefined,
      areaX100: p.areaX100,
      ratePaisePerSqft: p.ratePaisePerSqft,
      plcBp: p.plcBp,
      basePaise,
      plcPaise,
      lineTotalPaise: basePaise + plcPaise,
    };
  });

  const grossAmountPaise = items.reduce((s, i) => s + i.lineTotalPaise, 0);
  const chargesTotalPaise = input.charges.reduce((s, c) => s + c.amountPaise, 0);
  if (input.discountPaise > grossAmountPaise) throw businessRule('Discount cannot exceed the plot value');
  const netAmountPaise = grossAmountPaise - input.discountPaise + chargesTotalPaise;
  if (netAmountPaise <= 0) throw businessRule('Booking amount must be greater than zero');

  const plan = await loadPlan(ctx, input.paymentPlanId, projectId, session);
  const schedule = generateSchedule(plan.rules as PaymentPlanRule[], netAmountPaise, input.bookingDate);

  return {
    project,
    plots,
    items,
    plan,
    schedule,
    grossAmountPaise,
    chargesTotalPaise,
    netAmountPaise,
    discountPaise: input.discountPaise,
    charges: input.charges,
  };
}

/** Quotation: read-only pricing preview, no inventory is held. */
export async function quote(ctx: TenantContext, input: QuoteInput) {
  const priced = await priceBooking(ctx, input);
  return {
    items: priced.items,
    unavailable: priced.plots.filter((p) => p.status !== 'available').map((p) => ({ plotNumber: p.plotNumber, status: p.status })),
    grossAmountPaise: priced.grossAmountPaise,
    discountPaise: priced.discountPaise,
    charges: priced.charges,
    chargesTotalPaise: priced.chargesTotalPaise,
    netAmountPaise: priced.netAmountPaise,
    schedule: priced.schedule,
    planName: priced.plan.name,
  };
}

/**
 * Creates a booking atomically: plot status change, booking, booking items, installment
 * schedule, sales journal entry, status history and audit log commit together or not at all.
 *
 * Double-booking is prevented three ways:
 *  1. availability is re-checked inside the transaction,
 *  2. each plot is claimed with a conditional update (`status: 'available'`),
 *  3. a partial unique index allows only one active booking item per plot.
 */
export async function createBooking(ctx: TenantContext, input: CreateBookingInput) {
  if (input.discountPaise > 0 && !hasPermission(ctx, 'bookings.discount')) throw forbidden('You are not allowed to give discounts');
  await assertCustomerVisible(ctx, input.customerId);

  const company = await Company.findById(ctx.companyId).select('settings').lean();

  try {
    return await withTransaction(async (session) => {
      const priced = await priceBooking(ctx, input, session);
      const projectId = priced.project._id;

      const customer = await Customer.findOne({ companyId: ctx.companyId, _id: toObjectId(input.customerId), deletedAt: null })
        .session(session)
        .lean();
      if (!customer) throw badRequest('Customer not found');
      if (input.brokerId && !(await Broker.exists({ companyId: ctx.companyId, _id: toObjectId(input.brokerId) }).session(session))) {
        throw badRequest('Broker not found');
      }

      const unavailable = priced.plots.filter((p) => p.status !== 'available');
      if (unavailable.length) {
        throw new AppError(409, 'CONFLICT', `Plot ${unavailable.map((p) => p.plotNumber).join(', ')} is no longer available`);
      }

      const status: BookingStatus = input.mode === 'reserve' ? 'reserved' : 'booked';
      const plotStatus = status === 'reserved' ? 'reserved' : 'booked';
      const bookingId = new Types.ObjectId();

      for (const plot of priced.plots) {
        const claimed = await Plot.updateOne(
          { companyId: ctx.companyId, _id: plot._id, status: 'available' },
          { $set: { status: plotStatus, currentBookingId: bookingId } },
          { session },
        );
        if (claimed.modifiedCount !== 1) throw new AppError(409, 'CONFLICT', `Plot ${plot.plotNumber} was just booked by someone else`);
      }

      const fy = financialYear(input.bookingDate);
      const seq = await nextSequence(ctx.companyId, `booking:${fy}`, session);
      const bookingNumber = `${company?.settings?.bookingPrefix ?? 'BKG'}/${fy}/${String(seq).padStart(5, '0')}`;
      const holdHours = input.reservationHours ?? company?.settings?.reservationHoldHours ?? 72;

      const salesJe = await postJournal(
        ctx,
        {
          date: input.bookingDate,
          voucherType: 'sales',
          narration: `Booking ${bookingNumber} – ${customer.name} – plots ${priced.items.map((i) => i.plotNumber).join(', ')}`,
          reference: bookingNumber,
          projectId,
          lines: [
            { systemKey: 'customer_receivable', debitPaise: priced.netAmountPaise, customerId: customer._id, bookingId },
            { systemKey: 'plot_sales', creditPaise: priced.grossAmountPaise - priced.discountPaise },
            { systemKey: 'other_income', creditPaise: priced.chargesTotalPaise, narration: 'Booking charges' },
          ],
          source: { type: 'booking', id: bookingId },
          allowControlAccounts: true,
        },
        session,
      );

      const [booking] = await Booking.create(
        [
          {
            _id: bookingId,
            companyId: ctx.companyId,
            projectId,
            bookingNumber,
            customerId: customer._id,
            brokerId: input.brokerId ? toObjectId(input.brokerId) : undefined,
            paymentPlanId: priced.plan._id,
            planSnapshot: { name: priced.plan.name, rules: priced.plan.rules },
            status,
            bookingDate: parseISODate(input.bookingDate),
            reservedUntil: status === 'reserved' ? new Date(Date.now() + holdHours * 3600_000) : undefined,
            confirmedAt: status === 'booked' ? new Date() : undefined,
            grossAmountPaise: priced.grossAmountPaise,
            discountPaise: priced.discountPaise,
            charges: priced.charges,
            chargesTotalPaise: priced.chargesTotalPaise,
            netAmountPaise: priced.netAmountPaise,
            salesJournalEntryId: salesJe._id,
            remarks: input.remarks,
            createdBy: ctx.userId,
          },
        ],
        { session },
      );

      await BookingItem.insertMany(
        priced.items.map((i) => ({ companyId: ctx.companyId, projectId, bookingId, ...i, active: true })),
        { session },
      );
      await Installment.insertMany(
        priced.schedule.map((s) => ({
          companyId: ctx.companyId,
          projectId,
          bookingId,
          customerId: customer._id,
          sequence: s.sequence,
          name: s.name,
          dueDate: parseISODate(s.dueDate),
          amountPaise: s.amountPaise,
        })),
        { session },
      );
      for (const plot of priced.plots) {
        await recordPlotStatus(
          ctx,
          { projectId, plotId: plot._id, from: 'available', to: plotStatus, reason: `Booking ${bookingNumber}`, bookingId },
          session,
        );
      }
      await audit(
        ctx,
        {
          action: status === 'reserved' ? 'bookings.reserve' : 'bookings.create',
          entityType: 'booking',
          entityId: bookingId,
          summary: `${bookingNumber} for ${customer.name}`,
          changes: {
            plots: priced.items.map((i) => i.plotNumber),
            netAmountPaise: priced.netAmountPaise,
            discountPaise: priced.discountPaise,
          },
        },
        session,
      );
      if (status === 'booked') await accrueCommission(ctx, bookingId, session);
      return booking!.toJSON();
    });
  } catch (err) {
    // Unique index on active booking items: a concurrent transaction won the plot.
    if (
      (err as { code?: number; keyPattern?: Record<string, unknown> }).code === 11000 &&
      (err as { keyPattern?: Record<string, unknown> }).keyPattern?.plotId
    ) {
      throw new AppError(409, 'CONFLICT', 'One of the selected plots was just booked by someone else');
    }
    throw err;
  }
}

export async function listBookings(
  ctx: TenantContext,
  q: { page: number; pageSize: number; sort?: string; q?: string; status?: string; customerId?: string },
  projectId?: string,
) {
  const filter = scopedFilter(ctx, projectId);
  if (q.status) filter.status = q.status;
  if (q.customerId) filter.customerId = toObjectId(q.customerId);
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const customers = await Customer.find({ companyId: ctx.companyId, $or: [{ name: rx }, { phone: rx }] })
      .select('_id')
      .limit(200)
      .lean();
    filter.$or = [{ bookingNumber: rx }, { customerId: { $in: customers.map((c) => c._id) } }];
  }
  const sort = parseSort(q.sort, ['bookingNumber', 'bookingDate', 'netAmountPaise', 'createdAt', 'status'], { createdAt: -1 });
  const [items, total] = await Promise.all([
    Booking.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .select('-planSnapshot')
      .populate({ path: 'customerId', select: 'name phone customerCode', match: { companyId: ctx.companyId } })
      .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
      .lean(),
    Booking.countDocuments(filter),
  ]);
  const itemRows = await BookingItem.find({ companyId: ctx.companyId, bookingId: { $in: items.map((b) => b._id) } })
    .select('bookingId plotNumber blockCode')
    .lean();
  return {
    items: items.map((b) => ({
      ...b,
      id: String(b._id),
      plots: itemRows
        .filter((i) => String(i.bookingId) === String(b._id))
        .map((i) => (i.blockCode ? `${i.blockCode}-${i.plotNumber}` : i.plotNumber)),
    })),
    meta: pageMeta(q.page, q.pageSize, total),
  };
}

export async function getBooking(ctx: TenantContext, id: string) {
  const booking = await Booking.findOne({ companyId: ctx.companyId, _id: toObjectId(id) })
    .populate({ path: 'customerId', match: { companyId: ctx.companyId } })
    .populate({ path: 'projectId', select: 'name code address reraNumber', match: { companyId: ctx.companyId } })
    .populate({ path: 'brokerId', select: 'name phone', match: { companyId: ctx.companyId } })
    .lean();
  if (!booking) throw notFound('Booking');
  const projectId = (booking.projectId as unknown as { _id: Types.ObjectId })?._id ?? booking.projectId;
  assertProjectAccess(ctx, projectId);

  const [items, installments, payments] = await Promise.all([
    BookingItem.find({ companyId: ctx.companyId, bookingId: booking._id }).lean(),
    Installment.find({ companyId: ctx.companyId, bookingId: booking._id }).sort({ sequence: 1 }).lean(),
    Payment.find({ companyId: ctx.companyId, bookingId: booking._id }).sort({ createdAt: 1 }).lean(),
  ]);
  const today = parseISODate(todayInIndia());
  const enriched = installments.map((i) => ({
    ...i,
    id: String(i._id),
    balancePaise: i.amountPaise - i.paidPaise,
    overdue: i.status !== 'cancelled' && i.paidPaise < i.amountPaise && i.dueDate < today,
  }));
  const overduePaise = enriched.filter((i) => i.overdue).reduce((s, i) => s + i.balancePaise, 0);
  return {
    ...booking,
    id: String(booking._id),
    items,
    installments: enriched,
    payments,
    summary: {
      netAmountPaise: booking.netAmountPaise,
      receivedPaise: booking.receivedPaise,
      allocatedPaise: booking.allocatedPaise,
      advancePaise: booking.advancePaise,
      outstandingPaise:
        booking.status === 'cancelled' || booking.status === 'expired' ? 0 : booking.netAmountPaise - booking.allocatedPaise,
      overduePaise,
      refundablePaise: booking.refundablePaise,
      refundedPaise: booking.refundedPaise,
    },
  };
}

export async function confirmBooking(ctx: TenantContext, id: string) {
  return withTransaction(async (session) => {
    const booking = await Booking.findOne({ companyId: ctx.companyId, _id: toObjectId(id) })
      .session(session)
      .lean();
    if (!booking) throw notFound('Booking');
    assertProjectAccess(ctx, booking.projectId);
    if (!canTransitionBooking(booking.status, 'booked')) throw businessRule(`A ${booking.status} booking cannot be confirmed`);
    if (booking.reservedUntil && booking.reservedUntil < new Date()) throw businessRule('This reservation has expired');

    const res = await Booking.updateOne(
      { companyId: ctx.companyId, _id: booking._id, status: 'reserved' },
      { $set: { status: 'booked', confirmedAt: new Date() }, $unset: { reservedUntil: 1 } },
      { session },
    );
    if (res.modifiedCount !== 1) throw businessRule('Booking changed concurrently, please retry');

    const items = await BookingItem.find({ companyId: ctx.companyId, bookingId: booking._id, active: true }).session(session).lean();
    for (const item of items) {
      const upd = await Plot.updateOne(
        { companyId: ctx.companyId, _id: item.plotId, status: 'reserved', currentBookingId: booking._id },
        { $set: { status: 'booked' } },
        { session },
      );
      if (upd.modifiedCount !== 1) throw businessRule(`Plot ${item.plotNumber} is not held by this reservation`);
      await recordPlotStatus(
        ctx,
        {
          projectId: booking.projectId,
          plotId: item.plotId,
          from: 'reserved',
          to: 'booked',
          reason: `Booking ${booking.bookingNumber} confirmed`,
          bookingId: booking._id,
        },
        session,
      );
    }
    await audit(ctx, { action: 'bookings.confirm', entityType: 'booking', entityId: booking._id, summary: booking.bookingNumber }, session);
    await accrueCommission(ctx, booking._id, session);
    return { id: String(booking._id), status: 'booked' as const };
  });
}

/**
 * Cancels (or expires) a booking. Releases plots, cancels open installments, reverses the
 * sales entry and moves money already received into Refunds Payable (less any
 * cancellation charge, recognised as income). Refunds are then paid via `refund`.
 */
export async function closeBooking(
  actor: Actor,
  bookingId: Types.ObjectId,
  to: 'cancelled' | 'expired',
  input: CancelBookingInput,
  session: ClientSession,
  projectGuard?: (projectId: Types.ObjectId) => void,
) {
  const booking = await Booking.findOne({ companyId: actor.companyId, _id: bookingId }).session(session).lean();
  if (!booking) throw notFound('Booking');
  projectGuard?.(booking.projectId);
  if (!canTransitionBooking(booking.status, to)) throw businessRule(`A ${booking.status} booking cannot be ${to}`);
  if (input.cancellationChargePaise > booking.receivedPaise) {
    throw businessRule('Cancellation charges cannot exceed the amount received');
  }

  const refundable = booking.receivedPaise - input.cancellationChargePaise;
  const res = await Booking.updateOne(
    { companyId: actor.companyId, _id: booking._id, status: booking.status, receivedPaise: booking.receivedPaise },
    {
      $set: {
        status: to,
        closedAt: new Date(),
        refundablePaise: refundable,
        cancellation: { reason: input.reason, chargePaise: input.cancellationChargePaise, by: actor.userId },
      },
    },
    { session },
  );
  if (res.modifiedCount !== 1) throw businessRule('Booking changed concurrently, please retry');

  const today = todayInIndia();
  const journalIds: Types.ObjectId[] = [];
  if (booking.salesJournalEntryId) {
    const rev = await reverseJournal(actor, booking.salesJournalEntryId, `Booking ${booking.bookingNumber} ${to}`, session, today);
    journalIds.push(rev._id);
  }
  if (booking.receivedPaise > 0) {
    const reclass = await postJournal(
      actor,
      {
        date: today,
        voucherType: 'journal',
        narration: `Booking ${booking.bookingNumber} ${to}: amount received transferred to refunds payable`,
        reference: booking.bookingNumber,
        projectId: booking.projectId,
        lines: [
          { systemKey: 'customer_receivable', debitPaise: booking.allocatedPaise, customerId: booking.customerId, bookingId: booking._id },
          { systemKey: 'customer_advance', debitPaise: booking.advancePaise, customerId: booking.customerId, bookingId: booking._id },
          { systemKey: 'refund_payable', creditPaise: refundable, customerId: booking.customerId, bookingId: booking._id },
          { systemKey: 'cancellation_income', creditPaise: input.cancellationChargePaise, narration: 'Cancellation charges retained' },
        ],
        source: { type: 'booking_cancellation', id: booking._id },
        allowControlAccounts: true,
      },
      session,
    );
    journalIds.push(reclass._id);
  }
  await Booking.updateOne(
    { companyId: actor.companyId, _id: booking._id },
    { $set: { 'cancellation.journalEntryIds': journalIds } },
    { session },
  );

  await Installment.updateMany({ companyId: actor.companyId, bookingId: booking._id }, { $set: { status: 'cancelled' } }, { session });
  await cancelCommission(actor, booking._id, `Booking ${booking.bookingNumber} ${to}`, session);

  const items = await BookingItem.find({ companyId: actor.companyId, bookingId: booking._id, active: true }).session(session).lean();
  await BookingItem.updateMany(
    { companyId: actor.companyId, bookingId: booking._id, active: true },
    { $set: { active: false } },
    { session },
  );
  for (const item of items) {
    const plot = await Plot.findOneAndUpdate(
      { companyId: actor.companyId, _id: item.plotId, currentBookingId: booking._id, status: { $in: ['reserved', 'booked'] } },
      { $set: { status: 'available', currentBookingId: null } },
      { session },
    ).lean();
    if (plot) {
      await recordPlotStatus(
        actor,
        {
          projectId: booking.projectId,
          plotId: item.plotId,
          from: plot.status,
          to: 'available',
          reason: `Booking ${booking.bookingNumber} ${to}: ${input.reason}`,
          bookingId: booking._id,
        },
        session,
      );
    }
  }

  await audit(
    actor,
    {
      action: to === 'expired' ? 'bookings.expire' : 'bookings.cancel',
      entityType: 'booking',
      entityId: booking._id,
      summary: booking.bookingNumber,
      changes: { reason: input.reason, cancellationChargePaise: input.cancellationChargePaise, refundablePaise: refundable },
    },
    session,
  );
  return { id: String(booking._id), status: to, refundablePaise: refundable };
}

export async function cancelBooking(ctx: TenantContext, id: string, input: CancelBookingInput) {
  return withTransaction((session) =>
    closeBooking(ctx, toObjectId(id), 'cancelled', input, session, (pid) => assertProjectAccess(ctx, pid)),
  );
}

/** Job: expire reservations whose hold time has passed. Each booking runs in its own transaction. */
export async function expireReservations(now = new Date()): Promise<number> {
  const due = await Booking.find({ status: 'reserved', reservedUntil: { $lte: now } }, null, { crossTenant: true })
    .select('_id companyId')
    .limit(500)
    .lean();
  let expired = 0;
  for (const b of due) {
    try {
      await withTransaction((session) =>
        closeBooking(
          { companyId: b.companyId, userId: undefined as unknown as Types.ObjectId, meta: { requestId: 'job:reservation-expiry' } },
          b._id,
          'expired',
          { reason: 'Reservation hold period ended', cancellationChargePaise: 0 },
          session,
        ),
      );
      expired++;
    } catch (err) {
      // Usually the booking was confirmed/cancelled concurrently; log anything unexpected.
      if (!(err instanceof AppError)) logger.warn({ err, bookingId: String(b._id) }, 'Reservation expiry failed');
    }
  }
  return expired;
}
