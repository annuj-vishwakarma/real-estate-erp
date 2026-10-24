import { parseISODate, type CustomerInput, type ListQuery } from '@erp/shared';
import { withTransaction } from '../../db/transaction';
import { nextSequence } from '../../db/system.models';
import { audit } from '../../utils/audit';
import { businessRule, notFound } from '../../utils/errors';
import { escapeRegex, pageMeta, parseSort } from '../../utils/http';
import { toObjectId, type TenantContext } from '../../utils/tenant';
import { Booking } from '../bookings/booking.models';
import { JournalEntry } from '../accounting/accounting.models';
import { Customer } from './customer.models';

function normalize(input: Partial<CustomerInput>) {
  const { dateOfBirth, ...rest } = input;
  return { ...rest, ...(dateOfBirth ? { dateOfBirth: parseISODate(dateOfBirth) } : {}) };
}

/**
 * Customers are company-wide (one person may buy in several projects). Users restricted to
 * specific projects see only customers who have bookings in those projects, or customers
 * they created themselves.
 */
async function visibilityFilter(ctx: TenantContext): Promise<Record<string, unknown>> {
  const filter: Record<string, unknown> = { companyId: ctx.companyId, deletedAt: null };
  if (ctx.projectScope !== null) {
    const ids = await Booking.distinct('customerId', { companyId: ctx.companyId, projectId: { $in: ctx.projectScope } });
    filter.$or = [{ _id: { $in: ids } }, { createdBy: ctx.userId }];
  }
  return filter;
}

export async function assertCustomerVisible(ctx: TenantContext, customerId: string) {
  const filter = await visibilityFilter(ctx);
  const customer = await Customer.findOne({ ...filter, _id: toObjectId(customerId) }).lean();
  if (!customer) throw notFound('Customer');
  return customer;
}

export async function listCustomers(ctx: TenantContext, q: ListQuery) {
  const filter = await visibilityFilter(ctx);
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    const search = { $or: [{ name: rx }, { phone: rx }, { customerCode: rx }, { email: rx }] };
    if (filter.$or) {
      filter.$and = [{ $or: filter.$or }, search];
      delete filter.$or;
    } else Object.assign(filter, search);
  }
  const sort = parseSort(q.sort, ['name', 'customerCode', 'createdAt'], { createdAt: -1 });
  const [items, total] = await Promise.all([
    Customer.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .lean(),
    Customer.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.pageSize, total) };
}

export async function getCustomer(ctx: TenantContext, id: string) {
  const customer = await assertCustomerVisible(ctx, id);
  const bookingFilter: Record<string, unknown> = { companyId: ctx.companyId, customerId: customer._id };
  if (ctx.projectScope !== null) bookingFilter.projectId = { $in: ctx.projectScope };
  const bookings = await Booking.find(bookingFilter)
    .select('bookingNumber status projectId netAmountPaise allocatedPaise bookingDate')
    .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
    .sort({ createdAt: -1 })
    .lean();
  return { ...customer, id: String(customer._id), bookings };
}

export async function createCustomer(ctx: TenantContext, input: CustomerInput) {
  return withTransaction(async (session) => {
    const seq = await nextSequence(ctx.companyId, 'customer', session);
    const [customer] = await Customer.create(
      [{ companyId: ctx.companyId, customerCode: `C${String(seq).padStart(5, '0')}`, ...normalize(input), createdBy: ctx.userId }],
      { session },
    );
    await audit(ctx, { action: 'customers.create', entityType: 'customer', entityId: customer!._id, summary: customer!.name }, session);
    return customer!.toJSON();
  });
}

export async function updateCustomer(ctx: TenantContext, id: string, input: Partial<CustomerInput>) {
  await assertCustomerVisible(ctx, id);
  const customer = await Customer.findOneAndUpdate(
    { companyId: ctx.companyId, _id: toObjectId(id) },
    { $set: normalize(input) },
    { new: true, runValidators: true },
  ).lean();
  if (!customer) throw notFound('Customer');
  await audit(ctx, { action: 'customers.update', entityType: 'customer', entityId: customer._id, changes: input });
  return customer;
}

export async function deleteCustomer(ctx: TenantContext, id: string) {
  const customer = await assertCustomerVisible(ctx, id);
  if (await Booking.exists({ companyId: ctx.companyId, customerId: customer._id })) {
    throw businessRule('Customers with bookings cannot be deleted');
  }
  await Customer.updateOne({ companyId: ctx.companyId, _id: customer._id }, { $set: { deletedAt: new Date() } });
  await audit(ctx, { action: 'customers.delete', entityType: 'customer', entityId: customer._id });
}

/**
 * Customer ledger derived from posted journal lines tagged with the customer on the
 * receivable / advance / refund-payable control accounts. Positive balance = customer owes.
 */
export async function customerLedger(ctx: TenantContext, id: string) {
  const customer = await assertCustomerVisible(ctx, id);
  const match: Record<string, unknown> = { companyId: ctx.companyId, 'lines.customerId': customer._id };
  if (ctx.projectScope !== null) match.projectId = { $in: ctx.projectScope };
  const rows = await JournalEntry.aggregate<{
    _id: unknown;
    entryNumber: string;
    date: Date;
    narration: string;
    voucherType: string;
    debitPaise: number;
    creditPaise: number;
    bookingId?: unknown;
  }>([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.customerId': customer._id } },
    { $sort: { date: 1, createdAt: 1, _id: 1 } },
    {
      $project: {
        entryNumber: 1,
        date: 1,
        narration: { $ifNull: ['$lines.narration', '$narration'] },
        voucherType: 1,
        debitPaise: '$lines.debitPaise',
        creditPaise: '$lines.creditPaise',
        bookingId: '$lines.bookingId',
      },
    },
  ]);
  let balance = 0;
  const entries = rows.map((r) => {
    balance += r.debitPaise - r.creditPaise;
    return { ...r, balancePaise: balance };
  });
  return {
    customer: { id: String(customer._id), name: customer.name, customerCode: customer.customerCode, phone: customer.phone },
    entries,
    totals: {
      debitPaise: rows.reduce((s, r) => s + r.debitPaise, 0),
      creditPaise: rows.reduce((s, r) => s + r.creditPaise, 0),
      balancePaise: balance,
    },
  };
}
