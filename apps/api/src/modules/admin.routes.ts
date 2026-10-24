import { Router } from 'express';
import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  companyUpdateSchema,
  idParam,
  inviteUserSchema,
  isoDate,
  listQuerySchema,
  objectId,
  roleSchema,
  updateMembershipSchema,
  type CompanyUpdateInput,
  type InviteUserInput,
  type ListQuery,
  type RoleInput,
  type UpdateMembershipInput,
} from '@erp/shared';
import { authorize } from '../middleware/auth';
import { body, params, query, validate } from '../middleware/validate';
import { created, escapeRegex, ok, pageMeta } from '../utils/http';
import { getCtx } from '../utils/tenant';
import { AuditLog } from './audit/audit.model';
import * as companies from './companies/company.service';
import { Notification } from './notifications/notification.model';
import { Membership } from './users/user.models';
import * as roles from './roles/roles.service';
import * as users from './users/users.service';

export const adminRouter = Router();

// Company
adminRouter.get('/company', authorize('company.read'), async (req, res) => ok(res, await companies.getCompany(getCtx(req))));
adminRouter.patch('/company', authorize('company.update'), validate({ body: companyUpdateSchema }), async (req, res) =>
  ok(res, await companies.updateCompany(getCtx(req), body<CompanyUpdateInput>(req))),
);

// Users & invitations
adminRouter.get('/users', authorize('users.read'), validate({ query: listQuerySchema }), async (req, res) => {
  const { items, meta } = await users.listMembers(getCtx(req), query<ListQuery>(req));
  ok(res, items, meta);
});
adminRouter.patch('/users/:id', authorize('users.update'), validate({ params: idParam, body: updateMembershipSchema }), async (req, res) =>
  ok(res, await users.updateMembership(getCtx(req), params<{ id: string }>(req).id, body<UpdateMembershipInput>(req))),
);
adminRouter.get('/invitations', authorize('users.read'), async (req, res) => ok(res, await users.listInvitations(getCtx(req))));
adminRouter.post('/invitations', authorize('users.create'), validate({ body: inviteUserSchema }), async (req, res) =>
  created(res, await users.inviteUser(getCtx(req), body<InviteUserInput>(req))),
);
adminRouter.delete('/invitations/:id', authorize('users.create'), validate({ params: idParam }), async (req, res) => {
  await users.revokeInvitation(getCtx(req), params<{ id: string }>(req).id);
  ok(res, { revoked: true });
});

// Minimal member directory (names only) for pickers such as lead assignment.
adminRouter.get('/members', async (req, res) => {
  const ctx = getCtx(req);
  const members = await Membership.find({ companyId: ctx.companyId, status: 'active' }).populate('userId', 'name').lean();
  ok(
    res,
    members
      .map((m) => m.userId as unknown as { _id: unknown; name: string } | null)
      .filter(Boolean)
      .map((u) => ({ id: String(u!._id), name: u!.name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );
});

// Roles & permissions
adminRouter.get('/permissions', (_req, res) => ok(res, { groups: PERMISSION_GROUPS, labels: PERMISSION_LABELS, all: ALL_PERMISSIONS }));
adminRouter.get('/roles', authorize('roles.read'), async (req, res) => ok(res, await roles.listRoles(getCtx(req))));
adminRouter.post('/roles', authorize('roles.create'), validate({ body: roleSchema }), async (req, res) =>
  created(res, await roles.createRole(getCtx(req), body<RoleInput>(req))),
);
adminRouter.patch('/roles/:id', authorize('roles.update'), validate({ params: idParam, body: roleSchema.partial() }), async (req, res) =>
  ok(res, await roles.updateRole(getCtx(req), params<{ id: string }>(req).id, body<Partial<RoleInput>>(req))),
);
adminRouter.delete('/roles/:id', authorize('roles.delete'), validate({ params: idParam }), async (req, res) => {
  await roles.deleteRole(getCtx(req), params<{ id: string }>(req).id);
  ok(res, { deleted: true });
});

// Audit logs
const auditQuery = listQuerySchema.extend({
  entityType: z.string().max(40).optional(),
  entityId: objectId.optional(),
  actorId: objectId.optional(),
  action: z.string().max(60).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});
adminRouter.get('/audit-logs', authorize('audit.read'), validate({ query: auditQuery }), async (req, res) => {
  const ctx = getCtx(req);
  const q = query<z.infer<typeof auditQuery>>(req);
  const filter: Record<string, unknown> = { companyId: ctx.companyId };
  if (q.entityType) filter.entityType = q.entityType;
  if (q.entityId) filter.entityId = q.entityId;
  if (q.actorId) filter.actorId = q.actorId;
  if (q.action) filter.action = new RegExp(`^${escapeRegex(q.action)}`);
  if (q.from || q.to) {
    filter.createdAt = {
      ...(q.from ? { $gte: new Date(`${q.from}T00:00:00+05:30`) } : {}),
      ...(q.to ? { $lt: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}),
    };
  }
  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .populate('actorId', 'name email')
      .lean(),
    AuditLog.countDocuments(filter),
  ]);
  ok(res, items, pageMeta(q.page, q.pageSize, total));
});

// Notifications (always the caller's own)
adminRouter.get(
  '/notifications',
  validate({ query: listQuerySchema.extend({ unread: z.enum(['true', 'false']).optional() }) }),
  async (req, res) => {
    const ctx = getCtx(req);
    const q = query<ListQuery & { unread?: string }>(req);
    const filter: Record<string, unknown> = { companyId: ctx.companyId, userId: ctx.userId };
    if (q.unread === 'true') filter.readAt = null;
    const [items, total, unread] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip((q.page - 1) * q.pageSize)
        .limit(q.pageSize)
        .lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ companyId: ctx.companyId, userId: ctx.userId, readAt: null }),
    ]);
    res.setHeader('x-unread-count', String(unread));
    ok(res, { items, unread }, pageMeta(q.page, q.pageSize, total));
  },
);
adminRouter.post('/notifications/:id/read', validate({ params: idParam }), async (req, res) => {
  const ctx = getCtx(req);
  await Notification.updateOne(
    { companyId: ctx.companyId, userId: ctx.userId, _id: params<{ id: string }>(req).id },
    { $set: { readAt: new Date() } },
  );
  ok(res, { read: true });
});
adminRouter.post('/notifications/read-all', async (req, res) => {
  const ctx = getCtx(req);
  await Notification.updateMany({ companyId: ctx.companyId, userId: ctx.userId, readAt: null }, { $set: { readAt: new Date() } });
  ok(res, { read: true });
});
