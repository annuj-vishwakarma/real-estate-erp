import { Types, type ClientSession } from 'mongoose';
import { applyBasisPoints, formatINR, parseISODate, todayInIndia, type BrokerInput, type BrokerPayoutInput } from '@erp/shared';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../utils/audit';
import { businessRule, notFound } from '../../utils/errors';
import { escapeRegex } from '../../utils/http';
import { toObjectId, type TenantContext } from '../../utils/tenant';
import { nextDocumentNumber, partyBalance, postJournal, resolveCashAccountFor, reverseJournal } from '../accounting/ledger.service';
import { Booking } from '../bookings/booking.models';
import { Broker } from '../customers/customer.models';
import { BrokerCommission } from './commission.model';

type Actor = Pick<TenantContext, 'companyId' | 'userId' | 'meta'>;

export async function listBrokers(ctx: TenantContext, q?: string, includeInactive = false) {
  const filter: Record<string, unknown> = { companyId: ctx.companyId };
  if (!includeInactive) filter.isActive = true;
  if (q) {
    const rx = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ name: rx }, { phone: rx }, { firmName: rx }];
  }
  const brokers = await Broker.find(filter).sort({ name: 1 }).lean();
  const sums = await BrokerCommission.aggregate<{ _id: { b: Types.ObjectId; s: string }; amount: number; n: number }>([
    { $match: { companyId: ctx.companyId, brokerId: { $in: brokers.map((b) => b._id) } } },
    { $group: { _id: { b: '$brokerId', s: '$status' }, amount: { $sum: '$amountPaise' }, n: { $sum: 1 } } },
  ]);
  return brokers.map((b) => {
    const mine = sums.filter((s) => String(s._id.b) === String(b._id));
    const by = (s: string) => mine.find((m) => m._id.s === s)?.amount ?? 0;
    return { ...b, accruedPaise: by('accrued'), paidPaise: by('paid'), bookings: mine.filter((m) => m._id.s !== 'cancelled').reduce((a, m) => a + m.n, 0) };
  });
}

export async function getBroker(ctx: TenantContext, id: string) {
  const broker = await Broker.findOne({ companyId: ctx.companyId, _id: toObjectId(id) }).lean();
  if (!broker) throw notFound('Broker');
  const filter: Record<string, unknown> = { companyId: ctx.companyId, brokerId: broker._id };
  if (ctx.projectScope !== null) filter.projectId = { $in: ctx.projectScope };
  const commissions = await BrokerCommission.find(filter)
    .sort({ createdAt: -1 })
    .populate({ path: 'bookingId', select: 'bookingNumber status customerId', match: { companyId: ctx.companyId }, populate: { path: 'customerId', select: 'name', match: { companyId: ctx.companyId } } })
    .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
    .lean();
  const payableBalancePaise = await partyBalance(ctx.companyId, { brokerId: broker._id }, 'broker_payable');
  return { ...broker, commissions, payableBalancePaise };
}

export async function createBroker(ctx: TenantContext, input: BrokerInput) {
  const broker = await Broker.create({ companyId: ctx.companyId, ...input });
  await audit(ctx, { action: 'brokers.create', entityType: 'broker', entityId: broker._id, summary: broker.name });
  return broker.toJSON();
}

export async function updateBroker(ctx: TenantContext, id: string, input: Partial<BrokerInput>) {
  const broker = await Broker.findOneAndUpdate({ companyId: ctx.companyId, _id: toObjectId(id) }, { $set: input }, { new: true, runValidators: true }).lean();
  if (!broker) throw notFound('Broker');
  await audit(ctx, { action: 'brokers.update', entityType: 'broker', entityId: broker._id, changes: input });
  return broker;
}

/**
 * Accrues commission when a booking becomes confirmed. Base = plot value after discount
 * (other charges excluded). Idempotent via a unique index on the booking.
 */
export async function accrueCommission(actor: Actor, bookingId: Types.ObjectId, session: ClientSession) {
  const booking = await Booking.findOne({ companyId: actor.companyId, _id: bookingId }).session(session).lean();
  if (!booking?.brokerId || booking.status !== 'booked') return null;
  if (await BrokerCommission.exists({ companyId: actor.companyId, bookingId }).session(session)) return null;
  const broker = await Broker.findOne({ companyId: actor.companyId, _id: booking.brokerId }).session(session).lean();
  if (!broker || !broker.commissionBp) return null;
  const basePaise = booking.grossAmountPaise - booking.discountPaise;
  const amountPaise = applyBasisPoints(basePaise, broker.commissionBp);
  if (amountPaise <= 0) return null;
  const commissionId = new Types.ObjectId();
  const je = await postJournal(
    actor,
    {
      date: todayInIndia(),
      voucherType: 'journal',
      narration: `Brokerage to ${broker.name} on booking ${booking.bookingNumber} @ ${broker.commissionBp / 100}%`,
      reference: booking.bookingNumber,
      projectId: booking.projectId,
      lines: [
        { systemKey: 'brokerage_expense', debitPaise: amountPaise },
        { systemKey: 'broker_payable', creditPaise: amountPaise, brokerId: broker._id, bookingId: booking._id },
      ],
      source: { type: 'broker_commission', id: commissionId },
      allowControlAccounts: true,
    },
    session,
  );
  const [commission] = await BrokerCommission.create(
    [
      {
        _id: commissionId,
        companyId: actor.companyId,
        brokerId: broker._id,
        bookingId: booking._id,
        projectId: booking.projectId,
        basePaise,
        rateBp: broker.commissionBp,
        amountPaise,
        accrualJournalEntryId: je._id,
      },
    ],
    { session },
  );
  return commission;
}

/** On cancellation an unpaid accrual is reversed; a paid commission is left for manual recovery. */
export async function cancelCommission(actor: Actor, bookingId: Types.ObjectId, reason: string, session: ClientSession) {
  const c = await BrokerCommission.findOne({ companyId: actor.companyId, bookingId, status: 'accrued' }).session(session);
  if (!c) return;
  const rev = await reverseJournal(actor, c.accrualJournalEntryId!, `Commission cancelled: ${reason}`, session, todayInIndia());
  const res = await BrokerCommission.updateOne(
    { companyId: actor.companyId, _id: c._id, status: 'accrued' },
    { $set: { status: 'cancelled', cancelJournalEntryId: rev._id } },
    { session },
  );
  if (res.modifiedCount !== 1) throw businessRule('Commission changed concurrently, please retry');
}

/** Pays selected accrued commissions in one voucher. */
export async function payoutCommissions(ctx: TenantContext, brokerId: string, input: BrokerPayoutInput) {
  return withTransaction(async (session) => {
    const broker = await Broker.findOne({ companyId: ctx.companyId, _id: toObjectId(brokerId) }).session(session).lean();
    if (!broker) throw notFound('Broker');
    const ids = [...new Set(input.commissionIds)].map(toObjectId);
    const filter: Record<string, unknown> = { companyId: ctx.companyId, brokerId: broker._id, _id: { $in: ids }, status: 'accrued' };
    if (ctx.projectScope !== null) filter.projectId = { $in: ctx.projectScope };
    const commissions = await BrokerCommission.find(filter).session(session).lean();
    if (commissions.length !== ids.length) throw businessRule('Some commissions are already paid, cancelled or not visible to you');
    const total = commissions.reduce((s, c) => s + c.amountPaise, 0);

    const accountId = await resolveCashAccountFor(ctx.companyId, input.fromAccountId, input.mode, session);
    const number = await nextDocumentNumber(ctx.companyId, 'BPV', input.paidOn, session);
    const je = await postJournal(
      ctx,
      {
        date: input.paidOn,
        voucherType: 'payment',
        narration: `Brokerage payout ${number} to ${broker.name} (${commissions.length} booking${commissions.length > 1 ? 's' : ''})`,
        reference: number,
        lines: [
          { systemKey: 'broker_payable', debitPaise: total, brokerId: broker._id },
          { accountId, creditPaise: total },
        ],
        source: { type: 'broker_payout', id: broker._id },
        allowControlAccounts: true,
      },
      session,
    );
    const res = await BrokerCommission.updateMany(
      { companyId: ctx.companyId, _id: { $in: ids }, status: 'accrued' },
      { $set: { status: 'paid', payout: { number, paidOn: parseISODate(input.paidOn), mode: input.mode, accountId, reference: input.reference, journalEntryId: je._id } } },
      { session },
    );
    if (res.modifiedCount !== ids.length) throw businessRule('Commissions changed concurrently, please retry');
    await audit(ctx, { action: 'brokers.payout', entityType: 'broker', entityId: broker._id, summary: `${number} ${formatINR(total)}`, changes: { commissionIds: ids.map(String) } }, session);
    return { number, totalPaise: total, count: commissions.length, journalEntryId: String(je._id) };
  });
}
