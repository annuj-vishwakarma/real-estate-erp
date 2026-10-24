import { Types, type ClientSession } from 'mongoose';
import {
  financialYear,
  formatINR,
  parseISODate,
  todayInIndia,
  type InstallmentStatus,
  type PaymentMode,
  type RecordPaymentInput,
  type RefundInput,
} from '@erp/shared';
import { nextSequence } from '../../db/system.models';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../utils/audit';
import { badRequest, businessRule, notFound } from '../../utils/errors';
import { escapeRegex, pageMeta, parseSort } from '../../utils/http';
import { assertProjectAccess, scopedFilter, toObjectId, type TenantContext } from '../../utils/tenant';
import { Account } from '../accounting/accounting.models';
import { postJournal, resolveCashAccountFor, reverseJournal } from '../accounting/ledger.service';
import { Booking, Installment } from '../bookings/booking.models';
import { Company } from '../companies/company.model';
import { Customer } from '../customers/customer.models';
import { Payment, PaymentAllocation } from './payment.models';

function installmentStatus(amount: number, paid: number): InstallmentStatus {
  if (paid >= amount) return 'paid';
  return paid > 0 ? 'partial' : 'pending';
}

function resolveCashAccount(ctx: TenantContext, accountId: string | undefined, mode: PaymentMode, session: ClientSession) {
  return resolveCashAccountFor(ctx.companyId, accountId, mode, session);
}

/**
 * Records a customer receipt. In one transaction it:
 *  - allocates the amount to open installments, oldest due first (FIFO),
 *  - holds any excess as customer advance (or rejects it, per company policy),
 *  - allocates a gap-free receipt number,
 *  - posts the receipt journal (Dr cash/bank, Cr receivables / advances),
 *  - updates booking running totals.
 * Each installment is updated with an optimistic guard on its previous paid amount, so a
 * concurrent receipt can never double-allocate the same balance.
 */
export async function recordPayment(ctx: TenantContext, input: RecordPaymentInput) {
  const company = await Company.findById(ctx.companyId).select('settings').lean();
  const policy = company?.settings?.overpaymentPolicy ?? 'advance';

  return withTransaction(async (session) => {
    const booking = await Booking.findOne({ companyId: ctx.companyId, _id: toObjectId(input.bookingId) })
      .session(session)
      .lean();
    if (!booking) throw notFound('Booking');
    assertProjectAccess(ctx, booking.projectId);
    if (booking.status !== 'reserved' && booking.status !== 'booked') {
      throw businessRule(`Payments cannot be recorded against a ${booking.status} booking`);
    }

    const accountId = await resolveCashAccount(ctx, input.depositAccountId, input.mode, session);
    const open = await Installment.find({ companyId: ctx.companyId, bookingId: booking._id, status: { $in: ['pending', 'partial'] } })
      .sort({ dueDate: 1, sequence: 1 })
      .session(session)
      .lean();

    let remaining = input.amountPaise;
    const allocations: { installmentId: Types.ObjectId; amountPaise: number }[] = [];
    for (const inst of open) {
      if (remaining === 0) break;
      const balance = inst.amountPaise - inst.paidPaise;
      if (balance <= 0) continue;
      const take = Math.min(balance, remaining);
      const newPaid = inst.paidPaise + take;
      const upd = await Installment.updateOne(
        { companyId: ctx.companyId, _id: inst._id, paidPaise: inst.paidPaise },
        { $set: { paidPaise: newPaid, status: installmentStatus(inst.amountPaise, newPaid) } },
        { session },
      );
      if (upd.modifiedCount !== 1) throw businessRule('Installment changed concurrently, please retry');
      allocations.push({ installmentId: inst._id, amountPaise: take });
      remaining -= take;
    }
    const allocated = input.amountPaise - remaining;
    if (remaining > 0 && policy === 'reject') {
      throw businessRule(`Amount exceeds the outstanding balance by ${formatINR(remaining)}`);
    }

    const fy = financialYear(input.receivedOn);
    const seq = await nextSequence(ctx.companyId, `receipt:${fy}`, session);
    const number = `${company?.settings?.receiptPrefix ?? 'RCPT'}/${fy}/${String(seq).padStart(6, '0')}`;
    const paymentId = new Types.ObjectId();

    const je = await postJournal(
      ctx,
      {
        date: input.receivedOn,
        voucherType: 'receipt',
        narration: `Receipt ${number} against booking ${booking.bookingNumber} (${input.mode}${input.reference ? ` ${input.reference}` : ''})`,
        reference: number,
        projectId: booking.projectId,
        lines: [
          { accountId, debitPaise: input.amountPaise },
          { systemKey: 'customer_receivable', creditPaise: allocated, customerId: booking.customerId, bookingId: booking._id },
          {
            systemKey: 'customer_advance',
            creditPaise: remaining,
            customerId: booking.customerId,
            bookingId: booking._id,
            narration: 'Excess held as advance',
          },
        ],
        source: { type: 'payment', id: paymentId },
        allowControlAccounts: true,
      },
      session,
    );

    const [payment] = await Payment.create(
      [
        {
          _id: paymentId,
          companyId: ctx.companyId,
          projectId: booking.projectId,
          bookingId: booking._id,
          customerId: booking.customerId,
          kind: 'receipt',
          number,
          amountPaise: input.amountPaise,
          allocatedPaise: allocated,
          advancePaise: remaining,
          mode: input.mode,
          reference: input.reference,
          bankName: input.bankName,
          date: parseISODate(input.receivedOn),
          accountId,
          journalEntryId: je._id,
          remarks: input.remarks,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    if (allocations.length) {
      await PaymentAllocation.insertMany(
        allocations.map((a) => ({ companyId: ctx.companyId, paymentId, bookingId: booking._id, ...a })),
        { session },
      );
    }
    const totals = await Booking.updateOne(
      { companyId: ctx.companyId, _id: booking._id, status: booking.status },
      { $inc: { receivedPaise: input.amountPaise, allocatedPaise: allocated, advancePaise: remaining } },
      { session },
    );
    if (totals.modifiedCount !== 1) throw businessRule('Booking changed concurrently, please retry');

    await audit(
      ctx,
      {
        action: 'payments.create',
        entityType: 'payment',
        entityId: paymentId,
        summary: `${number} ${formatINR(input.amountPaise)} for ${booking.bookingNumber}`,
        changes: {
          allocations: allocations.map((a) => ({ installmentId: String(a.installmentId), amountPaise: a.amountPaise })),
          advancePaise: remaining,
        },
      },
      session,
    );
    return payment!.toJSON();
  });
}

/** Reverses a receipt (e.g. bounced cheque): un-allocates installments and posts a reversal. */
export async function reversePayment(ctx: TenantContext, id: string, reason: string) {
  return withTransaction(async (session) => {
    const payment = await Payment.findOne({ companyId: ctx.companyId, _id: toObjectId(id) })
      .session(session)
      .lean();
    if (!payment) throw notFound('Payment');
    assertProjectAccess(ctx, payment.projectId);
    if (payment.kind !== 'receipt') throw businessRule('Only receipts can be reversed');
    if (payment.status !== 'received') throw businessRule('This receipt has already been reversed');
    const booking = await Booking.findOne({ companyId: ctx.companyId, _id: payment.bookingId }).session(session).lean();
    if (!booking || (booking.status !== 'reserved' && booking.status !== 'booked')) {
      throw businessRule('Receipts of cancelled or expired bookings cannot be reversed; adjust the refund instead');
    }

    const marked = await Payment.updateOne(
      { companyId: ctx.companyId, _id: payment._id, status: 'received' },
      { $set: { status: 'reversed', reversal: { reason, at: new Date(), by: ctx.userId } } },
      { session },
    );
    if (marked.modifiedCount !== 1) throw businessRule('This receipt has already been reversed');

    const allocations = await PaymentAllocation.find({ companyId: ctx.companyId, paymentId: payment._id, reversedAt: null })
      .session(session)
      .lean();
    for (const a of allocations) {
      const inst = await Installment.findOne({ companyId: ctx.companyId, _id: a.installmentId }).session(session).lean();
      if (!inst) throw new Error('Allocation references a missing installment');
      const newPaid = inst.paidPaise - a.amountPaise;
      if (newPaid < 0) throw new Error('Allocation exceeds installment paid amount');
      const upd = await Installment.updateOne(
        { companyId: ctx.companyId, _id: inst._id, paidPaise: inst.paidPaise },
        { $set: { paidPaise: newPaid, status: installmentStatus(inst.amountPaise, newPaid) } },
        { session },
      );
      if (upd.modifiedCount !== 1) throw businessRule('Installment changed concurrently, please retry');
    }
    await PaymentAllocation.updateMany(
      { companyId: ctx.companyId, paymentId: payment._id, reversedAt: null },
      { $set: { reversedAt: new Date() } },
      { session },
    );

    const rev = await reverseJournal(
      ctx,
      payment.journalEntryId!,
      `Receipt ${payment.number} reversed: ${reason}`,
      session,
      todayInIndia(),
    );
    await Payment.updateOne({ companyId: ctx.companyId, _id: payment._id }, { $set: { 'reversal.journalEntryId': rev._id } }, { session });

    const totals = await Booking.updateOne(
      { companyId: ctx.companyId, _id: booking._id, status: booking.status, advancePaise: { $gte: payment.advancePaise } },
      { $inc: { receivedPaise: -payment.amountPaise, allocatedPaise: -payment.allocatedPaise, advancePaise: -payment.advancePaise } },
      { session },
    );
    if (totals.modifiedCount !== 1) throw businessRule('Booking changed concurrently, please retry');

    await audit(
      ctx,
      { action: 'payments.reverse', entityType: 'payment', entityId: payment._id, summary: payment.number, changes: { reason } },
      session,
    );
    return { id: String(payment._id), status: 'reversed' as const };
  });
}

/** Pays out part or all of the refundable balance of a cancelled booking. */
export async function refundBooking(ctx: TenantContext, bookingId: string, input: RefundInput) {
  return withTransaction(async (session) => {
    const booking = await Booking.findOne({ companyId: ctx.companyId, _id: toObjectId(bookingId) })
      .session(session)
      .lean();
    if (!booking) throw notFound('Booking');
    assertProjectAccess(ctx, booking.projectId);
    if (booking.status !== 'cancelled' && booking.status !== 'expired')
      throw businessRule('Refunds are only possible for cancelled bookings');
    if (input.amountPaise > booking.refundablePaise) {
      throw businessRule(`Refund exceeds the refundable balance of ${formatINR(booking.refundablePaise)}`);
    }

    const accountId = await resolveCashAccount(ctx, input.fromAccountId, input.mode, session);
    const fy = financialYear(input.paidOn);
    const seq = await nextSequence(ctx.companyId, `refund:${fy}`, session);
    const number = `RFD/${fy}/${String(seq).padStart(6, '0')}`;
    const paymentId = new Types.ObjectId();

    const je = await postJournal(
      ctx,
      {
        date: input.paidOn,
        voucherType: 'payment',
        narration: `Refund ${number} for cancelled booking ${booking.bookingNumber}`,
        reference: number,
        projectId: booking.projectId,
        lines: [
          { systemKey: 'refund_payable', debitPaise: input.amountPaise, customerId: booking.customerId, bookingId: booking._id },
          { accountId, creditPaise: input.amountPaise },
        ],
        source: { type: 'refund', id: paymentId },
        allowControlAccounts: true,
      },
      session,
    );

    const upd = await Booking.updateOne(
      { companyId: ctx.companyId, _id: booking._id, refundablePaise: { $gte: input.amountPaise } },
      { $inc: { refundablePaise: -input.amountPaise, refundedPaise: input.amountPaise } },
      { session },
    );
    if (upd.modifiedCount !== 1) throw businessRule('Refundable balance changed concurrently, please retry');

    const [refund] = await Payment.create(
      [
        {
          _id: paymentId,
          companyId: ctx.companyId,
          projectId: booking.projectId,
          bookingId: booking._id,
          customerId: booking.customerId,
          kind: 'refund',
          number,
          amountPaise: input.amountPaise,
          mode: input.mode,
          reference: input.reference,
          date: parseISODate(input.paidOn),
          accountId,
          journalEntryId: je._id,
          remarks: input.remarks,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    await audit(
      ctx,
      {
        action: 'payments.refund',
        entityType: 'payment',
        entityId: paymentId,
        summary: `${number} ${formatINR(input.amountPaise)} for ${booking.bookingNumber}`,
      },
      session,
    );
    return refund!.toJSON();
  });
}

export async function listPayments(
  ctx: TenantContext,
  q: {
    page: number;
    pageSize: number;
    sort?: string;
    q?: string;
    bookingId?: string;
    customerId?: string;
    kind?: string;
    from?: string;
    to?: string;
  },
  projectId?: string,
) {
  const filter = scopedFilter(ctx, projectId);
  if (q.bookingId) filter.bookingId = toObjectId(q.bookingId);
  if (q.customerId) filter.customerId = toObjectId(q.customerId);
  if (q.kind) filter.kind = q.kind;
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: parseISODate(q.from) } : {}), ...(q.to ? { $lte: parseISODate(q.to) } : {}) };
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const customers = await Customer.find({ companyId: ctx.companyId, $or: [{ name: rx }, { phone: rx }] })
      .select('_id')
      .limit(200)
      .lean();
    filter.$or = [{ number: rx }, { reference: rx }, { customerId: { $in: customers.map((c) => c._id) } }];
  }
  const sort = parseSort(q.sort, ['date', 'amountPaise', 'number', 'createdAt'], { createdAt: -1 });
  const [items, total] = await Promise.all([
    Payment.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .populate({ path: 'customerId', select: 'name phone customerCode', match: { companyId: ctx.companyId } })
      .populate({ path: 'bookingId', select: 'bookingNumber', match: { companyId: ctx.companyId } })
      .lean(),
    Payment.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.pageSize, total) };
}

export async function getPayment(ctx: TenantContext, id: string) {
  const payment = await Payment.findOne({ companyId: ctx.companyId, _id: toObjectId(id) })
    .populate({ path: 'customerId', match: { companyId: ctx.companyId } })
    .populate({ path: 'bookingId', select: 'bookingNumber netAmountPaise allocatedPaise status', match: { companyId: ctx.companyId } })
    .populate({ path: 'projectId', select: 'name code address', match: { companyId: ctx.companyId } })
    .populate({ path: 'accountId', select: 'name code', match: { companyId: ctx.companyId } })
    .lean();
  if (!payment) throw notFound('Payment');
  const pid = (payment.projectId as unknown as { _id: Types.ObjectId })?._id ?? payment.projectId;
  assertProjectAccess(ctx, pid);
  const allocations = await PaymentAllocation.find({ companyId: ctx.companyId, paymentId: payment._id })
    .populate({ path: 'installmentId', select: 'name sequence dueDate amountPaise', match: { companyId: ctx.companyId } })
    .lean();
  return { ...payment, id: String(payment._id), allocations };
}
