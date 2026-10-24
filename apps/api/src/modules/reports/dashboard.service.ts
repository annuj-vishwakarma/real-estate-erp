import type { Types } from 'mongoose';
import { addDays, addMonths, financialYear, OPEN_LEAD_STATUSES, parseISODate, todayInIndia } from '@erp/shared';
import { hasPermission, scopedFilter, type TenantContext } from '../../utils/tenant';
import { Account, JournalEntry } from '../accounting/accounting.models';
import { Booking, Installment } from '../bookings/booking.models';
import { Payment } from '../payments/payment.models';
import { Plot } from '../plots/plot.models';
import { WorkOrder } from '../construction/construction.models';
import { Lead } from '../crm/crm.models';
import { LandParcel } from '../land/land.model';

function monthStart(iso: string) {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * All dashboard metrics are aggregated from authorized records: company scope plus the
 * user's project scope (and an optional project filter). Sections the user lacks
 * permission for are omitted rather than zeroed.
 */
export async function getDashboard(ctx: TenantContext, projectId?: string) {
  const base = scopedFilter(ctx, projectId);
  const today = todayInIndia();
  const todayDate = parseISODate(today);
  const thisMonth = parseISODate(monthStart(today));
  const fyStart = parseISODate(`${financialYear(today).slice(0, 4)}-04-01`);
  const trendStartIso = addMonths(monthStart(today), -11);
  const trendStart = parseISODate(trendStartIso);

  const months: string[] = Array.from({ length: 12 }, (_, i) => addMonths(trendStartIso, i).slice(0, 7));

  const result: Record<string, unknown> = { asOf: today, months };

  if (hasPermission(ctx, 'inventory.read')) {
    const inv = await Plot.aggregate<{ _id: string; count: number; value: number; area: number }>([
      { $match: { ...base, deletedAt: null } },
      { $group: { _id: '$status', count: { $sum: 1 }, value: { $sum: '$listPricePaise' }, area: { $sum: '$areaX100' } } },
    ]);
    const byStatus = Object.fromEntries(inv.map((r) => [r._id, { count: r.count, valuePaise: r.value, areaX100: r.area }]));
    result.inventory = {
      byStatus,
      totalPlots: inv.reduce((s, r) => s + r.count, 0),
      availableValuePaise: byStatus.available?.valuePaise ?? 0,
    };
  }

  if (hasPermission(ctx, 'bookings.read')) {
    const active = { ...base, status: { $in: ['reserved', 'booked'] } };
    const [month, fy, trend, outstanding, recent] = await Promise.all([
      Booking.aggregate<{ count: number; value: number }>([
        { $match: { ...active, bookingDate: { $gte: thisMonth } } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$netAmountPaise' } } },
      ]),
      Booking.aggregate<{ count: number; value: number }>([
        { $match: { ...active, bookingDate: { $gte: fyStart } } },
        { $group: { _id: null, count: { $sum: 1 }, value: { $sum: '$netAmountPaise' } } },
      ]),
      Booking.aggregate<{ _id: string; count: number; value: number }>([
        { $match: { ...active, bookingDate: { $gte: trendStart } } },
        {
          $group: {
            _id: { $dateToString: { date: '$bookingDate', format: '%Y-%m' } },
            count: { $sum: 1 },
            value: { $sum: '$netAmountPaise' },
          },
        },
      ]),
      Booking.aggregate<{ value: number }>([
        { $match: active },
        { $group: { _id: null, value: { $sum: { $subtract: ['$netAmountPaise', '$allocatedPaise'] } } } },
      ]),
      Booking.find(base)
        .sort({ createdAt: -1 })
        .limit(6)
        .select('bookingNumber status netAmountPaise bookingDate customerId')
        .populate({ path: 'customerId', select: 'name', match: { companyId: ctx.companyId } })
        .lean(),
    ]);
    const trendMap = new Map(trend.map((t) => [t._id, t]));
    result.sales = {
      monthCount: month[0]?.count ?? 0,
      monthValuePaise: month[0]?.value ?? 0,
      fyCount: fy[0]?.count ?? 0,
      fyValuePaise: fy[0]?.value ?? 0,
      outstandingPaise: outstanding[0]?.value ?? 0,
      trend: months.map((m) => ({ month: m, count: trendMap.get(m)?.count ?? 0, valuePaise: trendMap.get(m)?.value ?? 0 })),
      recent,
    };
  }

  if (hasPermission(ctx, 'payments.read')) {
    const receipts = { ...base, kind: 'receipt', status: 'received' };
    const openInst = { ...base, status: { $in: ['pending', 'partial'] } };
    const [month, fy, trend, overdue, upcoming] = await Promise.all([
      Payment.aggregate<{ value: number }>([
        { $match: { ...receipts, date: { $gte: thisMonth } } },
        { $group: { _id: null, value: { $sum: '$amountPaise' } } },
      ]),
      Payment.aggregate<{ value: number }>([
        { $match: { ...receipts, date: { $gte: fyStart } } },
        { $group: { _id: null, value: { $sum: '$amountPaise' } } },
      ]),
      Payment.aggregate<{ _id: string; value: number }>([
        { $match: { ...receipts, date: { $gte: trendStart } } },
        { $group: { _id: { $dateToString: { date: '$date', format: '%Y-%m' } }, value: { $sum: '$amountPaise' } } },
      ]),
      Installment.aggregate<{ value: number; count: number }>([
        { $match: { ...openInst, dueDate: { $lt: todayDate } } },
        { $group: { _id: null, value: { $sum: { $subtract: ['$amountPaise', '$paidPaise'] } }, count: { $sum: 1 } } },
      ]),
      Installment.find({ ...openInst, dueDate: { $gte: todayDate, $lte: parseISODate(addDays(today, 30)) } })
        .sort({ dueDate: 1 })
        .limit(8)
        .select('name dueDate amountPaise paidPaise bookingId customerId')
        .populate({ path: 'customerId', select: 'name phone', match: { companyId: ctx.companyId } })
        .populate({ path: 'bookingId', select: 'bookingNumber', match: { companyId: ctx.companyId } })
        .lean(),
    ]);
    const trendMap = new Map(trend.map((t) => [t._id, t.value]));
    result.collections = {
      monthPaise: month[0]?.value ?? 0,
      fyPaise: fy[0]?.value ?? 0,
      overduePaise: overdue[0]?.value ?? 0,
      overdueCount: overdue[0]?.count ?? 0,
      trend: months.map((m) => ({ month: m, valuePaise: trendMap.get(m) ?? 0 })),
      upcoming,
    };
  }

  if (hasPermission(ctx, 'accounting.read')) {
    const expenseIds = (await Account.find({ companyId: ctx.companyId, type: 'expense' }).select('_id').lean()).map(
      (a) => a._id as Types.ObjectId,
    );
    const jeMatch: Record<string, unknown> = { companyId: ctx.companyId, date: { $gte: trendStart } };
    if (base.projectId) jeMatch.projectId = base.projectId;
    const rows = await JournalEntry.aggregate<{ _id: string; value: number }>([
      { $match: { ...jeMatch, 'lines.accountId': { $in: expenseIds } } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': { $in: expenseIds } } },
      {
        $group: {
          _id: { $dateToString: { date: '$date', format: '%Y-%m' } },
          value: { $sum: { $subtract: ['$lines.debitPaise', '$lines.creditPaise'] } },
        },
      },
    ]);
    const map = new Map(rows.map((r) => [r._id, r.value]));
    result.expenses = {
      monthPaise: map.get(today.slice(0, 7)) ?? 0,
      trend: months.map((m) => ({ month: m, valuePaise: map.get(m) ?? 0 })),
    };
  }

  const ops: Record<string, unknown> = {};
  if (hasPermission(ctx, 'crm.read')) {
    const leadMatch: Record<string, unknown> = { companyId: ctx.companyId, deletedAt: null };
    if (base.projectId) leadMatch.projectId = base.projectId;
    if (ctx.projectScope !== null && !base.projectId) leadMatch.$or = [{ projectId: { $in: ctx.projectScope } }, { assignedTo: ctx.userId }];
    const [open, due, won] = await Promise.all([
      Lead.countDocuments({ ...leadMatch, status: { $in: OPEN_LEAD_STATUSES } }),
      Lead.countDocuments({ ...leadMatch, status: { $in: OPEN_LEAD_STATUSES }, nextFollowUpAt: { $lte: new Date() } }),
      Lead.countDocuments({ ...leadMatch, status: 'won', convertedAt: { $gte: thisMonth } }),
    ]);
    ops.leads = { open, followUpsDue: due, wonThisMonth: won };
  }
  if (hasPermission(ctx, 'land.read')) {
    const landMatch: Record<string, unknown> = { companyId: ctx.companyId, deletedAt: null, status: { $ne: 'dropped' } };
    if (base.projectId) landMatch.projectId = base.projectId;
    const l = await LandParcel.aggregate<{ agreed: number; paid: number; n: number }>([
      { $match: landMatch },
      { $group: { _id: null, agreed: { $sum: { $ifNull: ['$agreedCostPaise', 0] } }, paid: { $sum: '$paidPaise' }, n: { $sum: 1 } } },
    ]);
    ops.land = { parcels: l[0]?.n ?? 0, agreedCostPaise: l[0]?.agreed ?? 0, paidPaise: l[0]?.paid ?? 0 };
  }
  if (hasPermission(ctx, 'construction.read')) {
    const w = await WorkOrder.aggregate<{ committed: number; billed: number; open: number }>([
      { $match: { ...base, status: { $in: ['issued', 'in_progress', 'completed'] } } },
      {
        $group: {
          _id: null,
          committed: { $sum: '$amountPaise' },
          billed: { $sum: '$billedPaise' },
          open: { $sum: { $cond: [{ $in: ['$status', ['issued', 'in_progress']] }, 1, 0] } },
        },
      },
    ]);
    ops.construction = { openWorkOrders: w[0]?.open ?? 0, committedPaise: w[0]?.committed ?? 0, billedPaise: w[0]?.billed ?? 0 };
  }
  if (Object.keys(ops).length) result.operations = ops;

  return result;
}
