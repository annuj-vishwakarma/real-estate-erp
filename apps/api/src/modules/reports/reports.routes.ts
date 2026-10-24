import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '@erp/shared';
import { authorize } from '../../middleware/auth';
import { query, validate } from '../../middleware/validate';
import { escapeRegex, ok } from '../../utils/http';
import { getCtx, hasPermission, scopedFilter } from '../../utils/tenant';
import { Booking } from '../bookings/booking.models';
import { Customer } from '../customers/customer.models';
import { Plot } from '../plots/plot.models';
import { Project } from '../projects/project.models';
import { Vendor } from '../construction/construction.models';
import { Lead } from '../crm/crm.models';
import { LandParcel } from '../land/land.model';
import { getDashboard } from './dashboard.service';

export const reportsRouter = Router();

reportsRouter.get(
  '/dashboard',
  authorize('dashboard.read'),
  validate({ query: z.object({ projectId: objectId.optional() }) }),
  async (req, res) => ok(res, await getDashboard(getCtx(req), query<{ projectId?: string }>(req).projectId)),
);

/** Global search across entities the caller may read. */
reportsRouter.get('/search', validate({ query: z.object({ q: z.string().trim().min(2).max(60) }) }), async (req, res) => {
  const ctx = getCtx(req);
  const rx = new RegExp(escapeRegex(query<{ q: string }>(req).q), 'i');
  const scoped = scopedFilter(ctx);
  const [projects, plots, customers, bookings, leads, vendors, land] = await Promise.all([
    hasPermission(ctx, 'projects.read')
      ? Project.find({ ...scopedFilter(ctx, undefined, '_id'), $or: [{ name: rx }, { code: rx }] })
          .select('name code')
          .limit(5)
          .lean()
      : [],
    hasPermission(ctx, 'inventory.read')
      ? Plot.find({ ...scoped, plotNumber: rx })
          .select('plotNumber projectId status')
          .limit(5)
          .lean()
      : [],
    hasPermission(ctx, 'customers.read') && ctx.projectScope === null
      ? Customer.find({ companyId: ctx.companyId, deletedAt: null, $or: [{ name: rx }, { phone: rx }, { customerCode: rx }] })
          .select('name phone customerCode')
          .limit(5)
          .lean()
      : [],
    hasPermission(ctx, 'bookings.read')
      ? Booking.find({ ...scoped, bookingNumber: rx })
          .select('bookingNumber status')
          .limit(5)
          .lean()
      : [],
    hasPermission(ctx, 'crm.read')
      ? Lead.find({
          companyId: ctx.companyId,
          deletedAt: null,
          $and: [
            { $or: [{ name: rx }, { phone: rx }] },
            ctx.projectScope === null ? {} : { $or: [{ projectId: { $in: ctx.projectScope } }, { assignedTo: ctx.userId }, { createdBy: ctx.userId }] },
          ],
        })
          .select('name phone status')
          .limit(5)
          .lean()
      : [],
    hasPermission(ctx, 'vendors.read') ? Vendor.find({ companyId: ctx.companyId, name: rx }).select('name category').limit(5).lean() : [],
    hasPermission(ctx, 'land.read')
      ? LandParcel.find({
          companyId: ctx.companyId,
          deletedAt: null,
          ...(ctx.projectScope === null ? {} : { projectId: { $in: ctx.projectScope } }),
          $or: [{ khasraNumber: rx }, { village: rx }, { 'owners.name': rx }],
        })
          .select('khasraNumber village status')
          .limit(5)
          .lean()
      : [],
  ]);
  ok(res, { projects, plots, customers, bookings, leads, vendors, land });
});
