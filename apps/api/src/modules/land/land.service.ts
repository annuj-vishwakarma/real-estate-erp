import { Types } from 'mongoose';
import { formatINR, LAND_TRANSITIONS, parseISODate, todayInIndia, type LandParcelInput, type LandPaymentInput, type LandStatus } from '@erp/shared';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../utils/audit';
import { badRequest, businessRule, notFound } from '../../utils/errors';
import { escapeRegex, pageMeta, parseSort } from '../../utils/http';
import { assertProjectAccess, toObjectId, type TenantContext } from '../../utils/tenant';
import { nextDocumentNumber, postJournal, resolveCashAccountFor } from '../accounting/ledger.service';
import { Project } from '../projects/project.models';
import { LandParcel, LandPayment } from './land.model';

/** Parcels not yet linked to a project are company-level; restricted users see only their projects' parcels. */
function visibility(ctx: TenantContext): Record<string, unknown> {
  const f: Record<string, unknown> = { companyId: ctx.companyId, deletedAt: null };
  if (ctx.projectScope !== null) f.projectId = { $in: ctx.projectScope };
  return f;
}

async function loadParcel(ctx: TenantContext, id: string) {
  const parcel = await LandParcel.findOne({ ...visibility(ctx), _id: toObjectId(id) });
  if (!parcel) throw notFound('Land parcel');
  return parcel;
}

async function checkProject(ctx: TenantContext, projectId?: string | null) {
  if (!projectId) {
    if (ctx.projectScope !== null) throw badRequest('Link the parcel to one of your projects');
    return null;
  }
  assertProjectAccess(ctx, projectId);
  if (!(await Project.exists({ companyId: ctx.companyId, _id: toObjectId(projectId) }))) throw badRequest('Project not found');
  return toObjectId(projectId);
}

function dates(input: Partial<LandParcelInput>) {
  const out: Record<string, unknown> = { ...input };
  for (const k of ['agreementDate', 'registryDate'] as const) if (input[k]) out[k] = parseISODate(input[k]!);
  return out;
}

export async function listParcels(ctx: TenantContext, q: { page: number; pageSize: number; sort?: string; q?: string; status?: string; projectId?: string }) {
  const filter = visibility(ctx);
  if (q.projectId) {
    assertProjectAccess(ctx, q.projectId);
    filter.projectId = toObjectId(q.projectId);
  }
  if (q.status) filter.status = q.status;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ khasraNumber: rx }, { village: rx }, { 'owners.name': rx }, { district: rx }];
  }
  const sort = parseSort(q.sort, ['khasraNumber', 'village', 'status', 'createdAt', 'agreedCostPaise'], { createdAt: -1 });
  const [items, total, totals] = await Promise.all([
    LandParcel.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .select('-statusHistory')
      .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
      .lean(),
    LandParcel.countDocuments(filter),
    LandParcel.aggregate<{ agreed: number; paid: number; count: number }>([
      { $match: { ...filter, status: { $ne: 'dropped' } } },
      { $group: { _id: null, agreed: { $sum: { $ifNull: ['$agreedCostPaise', 0] } }, paid: { $sum: '$paidPaise' }, count: { $sum: 1 } } },
    ]),
  ]);
  return {
    items,
    meta: pageMeta(q.page, q.pageSize, total),
    totals: { agreedCostPaise: totals[0]?.agreed ?? 0, paidPaise: totals[0]?.paid ?? 0, parcels: totals[0]?.count ?? 0 },
  };
}

export async function getParcel(ctx: TenantContext, id: string) {
  const parcel = await LandParcel.findOne({ ...visibility(ctx), _id: toObjectId(id) })
    .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
    .populate('statusHistory.by', 'name')
    .lean();
  if (!parcel) throw notFound('Land parcel');
  const payments = await LandPayment.find({ companyId: ctx.companyId, landParcelId: parcel._id })
    .sort({ date: 1, createdAt: 1 })
    .populate({ path: 'accountId', select: 'code name', match: { companyId: ctx.companyId } })
    .lean();
  return { ...parcel, payments, balancePaise: parcel.agreedCostPaise ? parcel.agreedCostPaise - parcel.paidPaise : null };
}

export async function createParcel(ctx: TenantContext, input: LandParcelInput) {
  const projectId = await checkProject(ctx, input.projectId);
  const parcel = await LandParcel.create({
    companyId: ctx.companyId,
    ...dates(input),
    projectId,
    status: 'negotiation',
    statusHistory: [{ from: null, to: 'negotiation', note: 'Parcel recorded', by: ctx.userId }],
    createdBy: ctx.userId,
  });
  await audit(ctx, { action: 'land.create', entityType: 'land_parcel', entityId: parcel._id, summary: `Khasra ${parcel.khasraNumber}, ${parcel.village}` });
  return parcel.toJSON();
}

export async function updateParcel(ctx: TenantContext, id: string, input: Partial<LandParcelInput>) {
  const parcel = await loadParcel(ctx, id);
  if (input.projectId !== undefined) parcel.projectId = await checkProject(ctx, input.projectId);
  if (input.agreedCostPaise !== undefined && input.agreedCostPaise < parcel.paidPaise) {
    throw businessRule(`Agreed cost cannot be below the ${formatINR(parcel.paidPaise)} already paid`);
  }
  const { projectId: _p, ...rest } = dates(input);
  parcel.set(rest);
  await parcel.save();
  await audit(ctx, { action: 'land.update', entityType: 'land_parcel', entityId: parcel._id, changes: input });
  return parcel.toJSON();
}

/** Moves a parcel through negotiation → agreement → registered → converted (or dropped). */
export async function changeStatus(ctx: TenantContext, id: string, to: LandStatus, date?: string, note?: string) {
  const parcel = await loadParcel(ctx, id);
  const from = parcel.status as LandStatus;
  if (!LAND_TRANSITIONS[from].includes(to)) throw businessRule(`A parcel in ${from} cannot move to ${to}`);
  if (to === 'dropped' && parcel.paidPaise > 0) throw businessRule('Parcels with payments to owners cannot be dropped');
  const when = parseISODate(date ?? todayInIndia());
  const set: Record<string, unknown> = { status: to };
  if (to === 'agreement' && !parcel.agreementDate) set.agreementDate = when;
  if (to === 'registered' && !parcel.registryDate) set.registryDate = when;
  const res = await LandParcel.updateOne(
    { companyId: ctx.companyId, _id: parcel._id, status: from },
    { $set: set, $push: { statusHistory: { from, to, note, at: new Date(), by: ctx.userId } } },
  );
  if (res.modifiedCount !== 1) throw businessRule('The parcel changed concurrently, please retry');
  await audit(ctx, { action: 'land.status_change', entityType: 'land_parcel', entityId: parcel._id, changes: { from, to, note } });
  return { id: String(parcel._id), status: to };
}

/** Payment to land owners, capitalised to Land & Development (WIP). Atomic and capped at the agreed cost. */
export async function recordLandPayment(ctx: TenantContext, id: string, input: LandPaymentInput) {
  return withTransaction(async (session) => {
    const parcel = await LandParcel.findOne({ ...visibility(ctx), _id: toObjectId(id) }).session(session).lean();
    if (!parcel) throw notFound('Land parcel');
    if (parcel.status === 'dropped' || parcel.status === 'negotiation') {
      throw businessRule('Record the agreement before paying land owners');
    }
    if (parcel.agreedCostPaise && parcel.paidPaise + input.amountPaise > parcel.agreedCostPaise) {
      throw businessRule(`Payment exceeds the balance of ${formatINR(parcel.agreedCostPaise - parcel.paidPaise)} on the agreed cost`);
    }
    const accountId = await resolveCashAccountFor(ctx.companyId, input.fromAccountId, input.mode, session);
    const number = await nextDocumentNumber(ctx.companyId, 'LPV', input.paidOn, session);
    const paymentId = new Types.ObjectId();
    const je = await postJournal(
      ctx,
      {
        date: input.paidOn,
        voucherType: 'payment',
        narration: `Land payment ${number}: khasra ${parcel.khasraNumber}, ${parcel.village}${input.payee ? ` to ${input.payee}` : ''}`,
        reference: number,
        projectId: parcel.projectId ?? undefined,
        lines: [
          { systemKey: 'land_inventory', debitPaise: input.amountPaise, narration: `Khasra ${parcel.khasraNumber}` },
          { accountId, creditPaise: input.amountPaise },
        ],
        source: { type: 'land_payment', id: paymentId },
      },
      session,
    );
    // Conditional increment: concurrent payments cannot overshoot the agreed cost.
    const cap = parcel.agreedCostPaise ? { paidPaise: { $lte: parcel.agreedCostPaise - input.amountPaise } } : {};
    const upd = await LandParcel.updateOne({ companyId: ctx.companyId, _id: parcel._id, ...cap }, { $inc: { paidPaise: input.amountPaise } }, { session });
    if (upd.modifiedCount !== 1) throw businessRule('Payment exceeds the remaining agreed cost');
    const [payment] = await LandPayment.create(
      [
        {
          _id: paymentId,
          companyId: ctx.companyId,
          number,
          landParcelId: parcel._id,
          projectId: parcel.projectId,
          amountPaise: input.amountPaise,
          date: parseISODate(input.paidOn),
          mode: input.mode,
          accountId,
          payee: input.payee,
          reference: input.reference,
          remarks: input.remarks,
          journalEntryId: je._id,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    await audit(ctx, { action: 'land.payment', entityType: 'land_parcel', entityId: parcel._id, summary: `${number} ${formatINR(input.amountPaise)}` }, session);
    return payment!.toJSON();
  });
}

export async function deleteParcel(ctx: TenantContext, id: string) {
  const parcel = await loadParcel(ctx, id);
  if (parcel.paidPaise > 0) throw businessRule('Parcels with payments cannot be deleted');
  await LandParcel.updateOne({ companyId: ctx.companyId, _id: parcel._id }, { $set: { deletedAt: new Date() } });
  await audit(ctx, { action: 'land.delete', entityType: 'land_parcel', entityId: parcel._id });
}
