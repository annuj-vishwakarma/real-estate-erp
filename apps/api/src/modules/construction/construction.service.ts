import { Types } from 'mongoose';
import {
  formatINR,
  parseISODate,
  todayInIndia,
  WORK_ORDER_TRANSITIONS,
  type ExpenseInput,
  type VendorInput,
  type VendorPaymentInput,
  type WorkOrderInput,
  type WorkOrderStatus,
} from '@erp/shared';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../utils/audit';
import { badRequest, businessRule, notFound } from '../../utils/errors';
import { escapeRegex, pageMeta, parseSort } from '../../utils/http';
import { assertProjectAccess, scopedFilter, toObjectId, type TenantContext } from '../../utils/tenant';
import { Account, JournalEntry } from '../accounting/accounting.models';
import {
  CONTROL_ACCOUNT_KEYS,
  nextDocumentNumber,
  partyBalance,
  postJournal,
  resolveCashAccountFor,
  reverseJournal,
  systemAccountId,
} from '../accounting/ledger.service';
import { LandPayment } from '../land/land.model';
import { Project } from '../projects/project.models';
import { Expense, Vendor, VendorPayment, WorkOrder } from './construction.models';

// ---------------- Vendors ----------------

export async function listVendors(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; sort?: string; category?: string; includeInactive?: boolean }) {
  const filter: Record<string, unknown> = { companyId: ctx.companyId };
  if (!q.includeInactive) filter.isActive = true;
  if (q.category) filter.category = q.category;
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ name: rx }, { phone: rx }, { gstin: rx }];
  }
  const sort = parseSort(q.sort, ['name', 'createdAt', 'category'], { name: 1 });
  const [items, total] = await Promise.all([
    Vendor.find(filter)
      .collation({ locale: 'en' })
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    Vendor.countDocuments(filter),
  ]);
  // Payable balances for the page in one aggregation over tagged journal lines.
  const payableId = await systemAccountId(ctx.companyId, 'vendor_payable');
  const balances = await JournalEntry.aggregate<{ _id: Types.ObjectId; debit: number; credit: number }>([
    { $match: { companyId: ctx.companyId, 'lines.vendorId': { $in: items.map((v) => v._id) } } },
    { $unwind: '$lines' },
    { $match: { 'lines.accountId': payableId, 'lines.vendorId': { $in: items.map((v) => v._id) } } },
    { $group: { _id: '$lines.vendorId', debit: { $sum: '$lines.debitPaise' }, credit: { $sum: '$lines.creditPaise' } } },
  ]);
  return {
    items: items.map((v) => {
      const b = balances.find((x) => String(x._id) === String(v._id));
      return { ...v, payablePaise: (b?.credit ?? 0) - (b?.debit ?? 0) };
    }),
    meta: pageMeta(q.page, q.pageSize, total),
  };
}

export async function getVendor(ctx: TenantContext, id: string) {
  const vendor = await Vendor.findOne({ companyId: ctx.companyId, _id: toObjectId(id) }).lean();
  if (!vendor) throw notFound('Vendor');
  const projectFilter = ctx.projectScope !== null ? { projectId: { $in: ctx.projectScope } } : {};
  const [workOrders, payableBalancePaise, ledger] = await Promise.all([
    WorkOrder.find({ companyId: ctx.companyId, vendorId: vendor._id, ...projectFilter })
      .sort({ createdAt: -1 })
      .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
      .lean(),
    partyBalance(ctx.companyId, { vendorId: vendor._id }, 'vendor_payable'),
    vendorLedger(ctx, vendor._id),
  ]);
  return { ...vendor, workOrders, payableBalancePaise, ledger };
}

/** Vendor statement: every payable-account line tagged with the vendor, with a running balance. */
async function vendorLedger(ctx: TenantContext, vendorId: Types.ObjectId) {
  const payableId = await systemAccountId(ctx.companyId, 'vendor_payable');
  const rows = await JournalEntry.aggregate<{ _id: Types.ObjectId; entryNumber: string; date: Date; narration: string; debitPaise: number; creditPaise: number }>([
    { $match: { companyId: ctx.companyId, 'lines.vendorId': vendorId } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
    { $unwind: '$lines' },
    { $match: { 'lines.vendorId': vendorId, 'lines.accountId': payableId } },
    { $project: { entryNumber: 1, date: 1, narration: { $ifNull: ['$lines.narration', '$narration'] }, debitPaise: '$lines.debitPaise', creditPaise: '$lines.creditPaise' } },
  ]);
  let bal = 0;
  return rows.map((r) => ({ ...r, balancePaise: (bal += r.creditPaise - r.debitPaise) }));
}

export async function createVendor(ctx: TenantContext, input: VendorInput) {
  const vendor = await Vendor.create({ companyId: ctx.companyId, ...input, createdBy: ctx.userId });
  await audit(ctx, { action: 'vendors.create', entityType: 'vendor', entityId: vendor._id, summary: vendor.name });
  return vendor.toJSON();
}

export async function updateVendor(ctx: TenantContext, id: string, input: Partial<VendorInput>) {
  const vendor = await Vendor.findOneAndUpdate({ companyId: ctx.companyId, _id: toObjectId(id) }, { $set: input }, { new: true, runValidators: true }).lean();
  if (!vendor) throw notFound('Vendor');
  await audit(ctx, { action: 'vendors.update', entityType: 'vendor', entityId: vendor._id, changes: input });
  return vendor;
}

// ---------------- Work orders ----------------

async function requireProject(ctx: TenantContext, projectId: string) {
  assertProjectAccess(ctx, projectId);
  const p = await Project.findOne({ companyId: ctx.companyId, _id: toObjectId(projectId) }).select('status').lean();
  if (!p) throw badRequest('Project not found');
  if (p.status === 'archived') throw businessRule('Project is archived');
  return p._id;
}

export async function listWorkOrders(ctx: TenantContext, q: { page: number; pageSize: number; q?: string; sort?: string; status?: string; projectId?: string; vendorId?: string }) {
  const filter = scopedFilter(ctx, q.projectId);
  if (q.status) filter.status = q.status;
  if (q.vendorId) filter.vendorId = toObjectId(q.vendorId);
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ number: rx }, { title: rx }];
  }
  const sort = parseSort(q.sort, ['number', 'createdAt', 'amountPaise', 'status'], { createdAt: -1 });
  const [items, total] = await Promise.all([
    WorkOrder.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .populate({ path: 'vendorId', select: 'name category', match: { companyId: ctx.companyId } })
      .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
      .lean(),
    WorkOrder.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.pageSize, total) };
}

export async function getWorkOrder(ctx: TenantContext, id: string) {
  const wo = await WorkOrder.findOne({ companyId: ctx.companyId, _id: toObjectId(id) })
    .populate({ path: 'vendorId', select: 'name category phone gstin', match: { companyId: ctx.companyId } })
    .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
    .lean();
  if (!wo) throw notFound('Work order');
  assertProjectAccess(ctx, (wo.projectId as unknown as { _id: Types.ObjectId })?._id ?? wo.projectId);
  const bills = await Expense.find({ companyId: ctx.companyId, workOrderId: wo._id }).sort({ date: -1 }).lean();
  return { ...wo, bills, remainingPaise: wo.amountPaise - wo.billedPaise };
}

function milestoneDocs(ms: WorkOrderInput['milestones']) {
  return ms.map((m) => ({ ...m, dueDate: m.dueDate ? parseISODate(m.dueDate) : undefined }));
}

export async function createWorkOrder(ctx: TenantContext, input: WorkOrderInput) {
  const projectId = await requireProject(ctx, input.projectId);
  const vendor = await Vendor.findOne({ companyId: ctx.companyId, _id: toObjectId(input.vendorId), isActive: true }).lean();
  if (!vendor) throw badRequest('Vendor not found or inactive');
  return withTransaction(async (session) => {
    const number = await nextDocumentNumber(ctx.companyId, 'WO', todayInIndia(), session);
    const [wo] = await WorkOrder.create(
      [
        {
          companyId: ctx.companyId,
          projectId,
          vendorId: vendor._id,
          number,
          title: input.title,
          scope: input.scope,
          amountPaise: input.amountPaise,
          startDate: input.startDate ? parseISODate(input.startDate) : undefined,
          endDate: input.endDate ? parseISODate(input.endDate) : undefined,
          milestones: milestoneDocs(input.milestones),
          status: 'draft',
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    await audit(ctx, { action: 'construction.work_order_create', entityType: 'work_order', entityId: wo!._id, summary: `${number} ${vendor.name} ${formatINR(input.amountPaise)}` }, session);
    return wo!.toJSON();
  });
}

export async function updateWorkOrder(ctx: TenantContext, id: string, input: Partial<Omit<WorkOrderInput, 'projectId' | 'vendorId'>>) {
  const wo = await WorkOrder.findOne({ companyId: ctx.companyId, _id: toObjectId(id) });
  if (!wo) throw notFound('Work order');
  assertProjectAccess(ctx, wo.projectId);
  if (wo.status === 'completed' || wo.status === 'cancelled') throw businessRule(`A ${wo.status} work order cannot be edited`);
  if (input.amountPaise !== undefined && input.amountPaise < wo.billedPaise) throw businessRule(`Amount cannot be below the ${formatINR(wo.billedPaise)} already billed`);
  const { milestones, startDate, endDate, ...rest } = input;
  wo.set(rest);
  if (startDate !== undefined) wo.startDate = startDate ? parseISODate(startDate) : undefined;
  if (endDate !== undefined) wo.endDate = endDate ? parseISODate(endDate) : undefined;
  if (milestones) {
    // Preserve completion of milestones that keep their name.
    const done = new Map(wo.milestones.map((m) => [m.name, m.completedAt]));
    wo.set('milestones', milestoneDocs(milestones).map((m) => ({ ...m, completedAt: done.get(m.name) })));
  }
  await wo.save();
  await audit(ctx, { action: 'construction.work_order_update', entityType: 'work_order', entityId: wo._id, changes: input });
  return wo.toJSON();
}

export async function changeWorkOrderStatus(ctx: TenantContext, id: string, to: WorkOrderStatus, note?: string) {
  const wo = await WorkOrder.findOne({ companyId: ctx.companyId, _id: toObjectId(id) }).lean();
  if (!wo) throw notFound('Work order');
  assertProjectAccess(ctx, wo.projectId);
  if (!WORK_ORDER_TRANSITIONS[wo.status as WorkOrderStatus].includes(to)) throw businessRule(`A ${wo.status} work order cannot become ${to}`);
  if (to === 'cancelled' && wo.billedPaise > 0) throw businessRule('Reverse the bills on this work order before cancelling it');
  const res = await WorkOrder.updateOne({ companyId: ctx.companyId, _id: wo._id, status: wo.status }, { $set: { status: to } });
  if (res.modifiedCount !== 1) throw businessRule('Work order changed concurrently, please retry');
  await audit(ctx, { action: 'construction.work_order_status', entityType: 'work_order', entityId: wo._id, changes: { from: wo.status, to, note } });
  return { id: String(wo._id), status: to };
}

export async function setMilestone(ctx: TenantContext, id: string, milestoneId: string, completed: boolean, date?: string) {
  const wo = await WorkOrder.findOne({ companyId: ctx.companyId, _id: toObjectId(id) });
  if (!wo) throw notFound('Work order');
  assertProjectAccess(ctx, wo.projectId);
  if (wo.status === 'cancelled' || wo.status === 'draft') throw businessRule('Issue the work order before recording progress');
  const m = wo.milestones.find((x) => String(x._id) === milestoneId);
  if (!m) throw notFound('Milestone');
  m.completedAt = completed ? parseISODate(date ?? todayInIndia()) : undefined;
  await wo.save();
  await audit(ctx, { action: 'construction.milestone', entityType: 'work_order', entityId: wo._id, changes: { milestone: m.name, completed } });
  return wo.toJSON();
}

// ---------------- Expenses / vendor bills ----------------

export async function listExpenses(
  ctx: TenantContext,
  q: { page: number; pageSize: number; q?: string; sort?: string; projectId?: string; vendorId?: string; workOrderId?: string; from?: string; to?: string },
) {
  const filter: Record<string, unknown> = { companyId: ctx.companyId };
  if (q.projectId) {
    assertProjectAccess(ctx, q.projectId);
    filter.projectId = toObjectId(q.projectId);
  } else if (ctx.projectScope !== null) filter.projectId = { $in: ctx.projectScope };
  if (q.vendorId) filter.vendorId = toObjectId(q.vendorId);
  if (q.workOrderId) filter.workOrderId = toObjectId(q.workOrderId);
  if (q.from || q.to) filter.date = { ...(q.from ? { $gte: parseISODate(q.from) } : {}), ...(q.to ? { $lte: parseISODate(q.to) } : {}) };
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    filter.$or = [{ number: rx }, { description: rx }, { billNumber: rx }];
  }
  const sort = parseSort(q.sort, ['date', 'amountPaise', 'number', 'createdAt'], { date: -1 });
  const [items, total, totals] = await Promise.all([
    Expense.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .populate({ path: 'vendorId', select: 'name', match: { companyId: ctx.companyId } })
      .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
      .populate({ path: 'expenseAccountId', select: 'code name', match: { companyId: ctx.companyId } })
      .populate({ path: 'workOrderId', select: 'number title', match: { companyId: ctx.companyId } })
      .lean(),
    Expense.countDocuments(filter),
    Expense.aggregate<{ amount: number }>([{ $match: { ...filter, status: 'posted' } }, { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]),
  ]);
  return { items, meta: pageMeta(q.page, q.pageSize, total), totalPaise: totals[0]?.amount ?? 0 };
}

/**
 * Records a bill or expense and posts it, atomically:
 *   paid:    Dr expense / WIP   Cr cash/bank
 *   payable: Dr expense / WIP   Cr Vendor Payables (tagged with the vendor)
 * Bills against a work order can never exceed its amount (conditional increment).
 */
export async function createExpense(ctx: TenantContext, input: ExpenseInput) {
  return withTransaction(async (session) => {
    const c = ctx.companyId;
    let projectId: Types.ObjectId | undefined;
    if (input.projectId) projectId = await requireProject(ctx, input.projectId);
    else if (ctx.projectScope !== null) throw badRequest('Choose one of your projects');

    const account = await Account.findOne({ companyId: c, _id: toObjectId(input.expenseAccountId), isActive: true }).session(session).lean();
    const capitalised = account?.systemKey === 'land_inventory';
    if (!account || (account.type !== 'expense' && !capitalised)) throw badRequest('Choose an expense account (or Land & Development WIP)');
    if (account.systemKey && (CONTROL_ACCOUNT_KEYS as string[]).includes(account.systemKey)) throw badRequest('Control accounts cannot be used here');

    let vendorId: Types.ObjectId | undefined;
    if (input.vendorId) {
      const vendor = await Vendor.findOne({ companyId: c, _id: toObjectId(input.vendorId) }).session(session).lean();
      if (!vendor) throw badRequest('Vendor not found');
      vendorId = vendor._id;
    }

    let workOrder: { _id: Types.ObjectId; number: string } | undefined;
    if (input.workOrderId) {
      const wo = await WorkOrder.findOne({ companyId: c, _id: toObjectId(input.workOrderId) }).session(session).lean();
      if (!wo) throw badRequest('Work order not found');
      if (!projectId || String(wo.projectId) !== String(projectId)) throw badRequest('The work order belongs to a different project');
      if (!vendorId || String(wo.vendorId) !== String(vendorId)) throw badRequest('The work order belongs to a different vendor');
      if (!['issued', 'in_progress', 'completed'].includes(wo.status)) throw businessRule(`Bills cannot be booked against a ${wo.status} work order`);
      const upd = await WorkOrder.updateOne(
        { companyId: c, _id: wo._id, billedPaise: { $lte: wo.amountPaise - input.amountPaise } },
        { $inc: { billedPaise: input.amountPaise } },
        { session },
      );
      if (upd.modifiedCount !== 1) throw businessRule(`Bill exceeds the remaining ${formatINR(wo.amountPaise - wo.billedPaise)} on ${wo.number}`);
      workOrder = { _id: wo._id, number: wo.number };
    }

    const number = await nextDocumentNumber(c, 'EXP', input.date, session);
    const expenseId = new Types.ObjectId();
    const credit =
      input.settlement === 'paid'
        ? { accountId: await resolveCashAccountFor(c, input.paidFromAccountId, input.mode ?? 'neft', session), creditPaise: input.amountPaise }
        : { systemKey: 'vendor_payable' as const, creditPaise: input.amountPaise, vendorId, narration: input.billNumber ? `Bill ${input.billNumber}` : undefined };
    const je = await postJournal(
      ctx,
      {
        date: input.date,
        voucherType: input.settlement === 'paid' ? 'payment' : 'journal',
        narration: `${number}: ${input.description}${workOrder ? ` (${workOrder.number})` : ''}`,
        reference: input.billNumber ?? number,
        projectId,
        lines: [{ accountId: account._id, debitPaise: input.amountPaise, narration: input.description }, credit],
        source: { type: 'expense', id: expenseId },
        allowControlAccounts: input.settlement === 'payable',
      },
      session,
    );
    const [expense] = await Expense.create(
      [
        {
          _id: expenseId,
          companyId: c,
          number,
          projectId,
          vendorId,
          workOrderId: workOrder?._id,
          expenseAccountId: account._id,
          date: parseISODate(input.date),
          amountPaise: input.amountPaise,
          description: input.description,
          billNumber: input.billNumber,
          settlement: input.settlement,
          mode: input.settlement === 'paid' ? (input.mode ?? 'neft') : undefined,
          paidFromAccountId: input.settlement === 'paid' ? (credit as { accountId: Types.ObjectId }).accountId : undefined,
          journalEntryId: je._id,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    await audit(ctx, { action: 'expenses.create', entityType: 'expense', entityId: expenseId, summary: `${number} ${formatINR(input.amountPaise)} ${input.description}` }, session);
    return expense!.toJSON();
  });
}

export async function reverseExpense(ctx: TenantContext, id: string, reason: string) {
  return withTransaction(async (session) => {
    const exp = await Expense.findOne({ companyId: ctx.companyId, _id: toObjectId(id) }).session(session).lean();
    if (!exp) throw notFound('Expense');
    if (exp.projectId) assertProjectAccess(ctx, exp.projectId);
    if (exp.status !== 'posted') throw businessRule('This expense has already been reversed');
    if (exp.settlement === 'payable' && exp.vendorId) {
      // Do not let a reversal turn the vendor's balance into an unexplained advance.
      const balance = await partyBalance(ctx.companyId, { vendorId: exp.vendorId }, 'vendor_payable', session);
      if (balance < exp.amountPaise) throw businessRule('This bill has already been paid; record a vendor refund or adjustment instead');
    }
    const rev = await reverseJournal(ctx, exp.journalEntryId!, `Expense ${exp.number} reversed: ${reason}`, session, todayInIndia());
    const res = await Expense.updateOne(
      { companyId: ctx.companyId, _id: exp._id, status: 'posted' },
      { $set: { status: 'reversed', reversal: { reason, at: new Date(), by: ctx.userId, journalEntryId: rev._id } } },
      { session },
    );
    if (res.modifiedCount !== 1) throw businessRule('This expense has already been reversed');
    if (exp.workOrderId) await WorkOrder.updateOne({ companyId: ctx.companyId, _id: exp.workOrderId }, { $inc: { billedPaise: -exp.amountPaise } }, { session });
    await audit(ctx, { action: 'expenses.reverse', entityType: 'expense', entityId: exp._id, summary: exp.number, changes: { reason } }, session);
    return { id: String(exp._id), status: 'reversed' as const };
  });
}

/** Pays a vendor against their payable balance (Dr Vendor Payables, Cr cash/bank). */
export async function payVendor(ctx: TenantContext, vendorId: string, input: VendorPaymentInput) {
  return withTransaction(async (session) => {
    const vendor = await Vendor.findOne({ companyId: ctx.companyId, _id: toObjectId(vendorId) }).session(session).lean();
    if (!vendor) throw notFound('Vendor');
    let projectId: Types.ObjectId | undefined;
    if (input.projectId) projectId = await requireProject(ctx, input.projectId);
    const balance = await partyBalance(ctx.companyId, { vendorId: vendor._id }, 'vendor_payable', session);
    if (input.amountPaise > balance) throw businessRule(`Payment exceeds the ${formatINR(balance)} payable to ${vendor.name}`);
    const accountId = await resolveCashAccountFor(ctx.companyId, input.fromAccountId, input.mode, session);
    const number = await nextDocumentNumber(ctx.companyId, 'VPV', input.paidOn, session);
    const paymentId = new Types.ObjectId();
    const je = await postJournal(
      ctx,
      {
        date: input.paidOn,
        voucherType: 'payment',
        narration: `Vendor payment ${number} to ${vendor.name}${input.reference ? ` (${input.reference})` : ''}`,
        reference: number,
        projectId,
        lines: [
          { systemKey: 'vendor_payable', debitPaise: input.amountPaise, vendorId: vendor._id },
          { accountId, creditPaise: input.amountPaise },
        ],
        source: { type: 'vendor_payment', id: paymentId },
        allowControlAccounts: true,
      },
      session,
    );
    const [payment] = await VendorPayment.create(
      [
        {
          _id: paymentId,
          companyId: ctx.companyId,
          number,
          vendorId: vendor._id,
          projectId,
          amountPaise: input.amountPaise,
          date: parseISODate(input.paidOn),
          mode: input.mode,
          accountId,
          reference: input.reference,
          remarks: input.remarks,
          journalEntryId: je._id,
          createdBy: ctx.userId,
        },
      ],
      { session },
    );
    await audit(ctx, { action: 'vendors.payment', entityType: 'vendor', entityId: vendor._id, summary: `${number} ${formatINR(input.amountPaise)}` }, session);
    return payment!.toJSON();
  });
}

/** Project cost overview: land paid, committed vs billed work orders, expenses by account. */
export async function projectCosts(ctx: TenantContext, projectId?: string) {
  const base = scopedFilter(ctx, projectId);
  const [land, orders, byAccount, byProject] = await Promise.all([
    LandPayment.aggregate<{ amount: number }>([{ $match: base }, { $group: { _id: null, amount: { $sum: '$amountPaise' } } }]),
    WorkOrder.aggregate<{ committed: number; billed: number; open: number }>([
      { $match: { ...base, status: { $ne: 'cancelled' } } },
      {
        $group: {
          _id: null,
          committed: { $sum: '$amountPaise' },
          billed: { $sum: '$billedPaise' },
          open: { $sum: { $cond: [{ $in: ['$status', ['issued', 'in_progress']] }, 1, 0] } },
        },
      },
    ]),
    Expense.aggregate<{ _id: Types.ObjectId; amount: number }>([
      { $match: { ...base, status: 'posted' } },
      { $group: { _id: '$expenseAccountId', amount: { $sum: '$amountPaise' } } },
    ]),
    Expense.aggregate<{ _id: Types.ObjectId | null; amount: number }>([
      { $match: { ...base, status: 'posted' } },
      { $group: { _id: '$projectId', amount: { $sum: '$amountPaise' } } },
    ]),
  ]);
  const accounts = await Account.find({ companyId: ctx.companyId, _id: { $in: byAccount.map((a) => a._id) } }).select('code name').lean();
  const projects = await Project.find({ companyId: ctx.companyId, _id: { $in: byProject.map((p) => p._id).filter(Boolean) } }).select('name code').lean();
  return {
    landPaidPaise: land[0]?.amount ?? 0,
    workOrders: { committedPaise: orders[0]?.committed ?? 0, billedPaise: orders[0]?.billed ?? 0, open: orders[0]?.open ?? 0 },
    expensesPaise: byAccount.reduce((s, a) => s + a.amount, 0),
    byAccount: byAccount
      .map((a) => ({ accountId: String(a._id), ...(accounts.find((x) => String(x._id) === String(a._id)) ?? { code: '', name: 'Unknown' }), amountPaise: a.amount }))
      .sort((x, y) => y.amountPaise - x.amountPaise),
    byProject: byProject.map((p) => ({
      projectId: p._id ? String(p._id) : null,
      name: projects.find((x) => String(x._id) === String(p._id))?.name ?? 'Company-wide',
      amountPaise: p.amount,
    })),
  };
}
