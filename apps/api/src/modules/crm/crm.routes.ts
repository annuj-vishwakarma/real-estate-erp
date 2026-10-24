import { Router } from 'express';
import { z } from 'zod';
import {
  idParam,
  leadActivitySchema,
  leadAssignSchema,
  leadListQuerySchema,
  leadSchema,
  leadStatusSchema,
  leadUpdateSchema,
  objectId,
  type LeadActivityInput,
  type LeadInput,
  type LeadStatus,
} from '@erp/shared';
import { authorize } from '../../middleware/auth';
import { body, params, query, validate } from '../../middleware/validate';
import { created, ok } from '../../utils/http';
import { getCtx } from '../../utils/tenant';
import * as crm from './crm.service';

export const crmRouter = Router();
type Id = { id: string };

crmRouter.get('/', authorize('crm.read'), validate({ query: leadListQuerySchema }), async (req, res) => {
  const { items, meta } = await crm.listLeads(getCtx(req), query(req));
  ok(res, items, meta);
});
crmRouter.get('/summary', authorize('crm.read'), validate({ query: z.object({ projectId: objectId.optional() }) }), async (req, res) =>
  ok(res, await crm.leadSummary(getCtx(req), query<{ projectId?: string }>(req).projectId)),
);
crmRouter.post('/', authorize('crm.create'), validate({ body: leadSchema }), async (req, res) => {
  const ctx = getCtx(req);
  const input = body<LeadInput>(req);
  // Choosing someone else as owner at creation needs the assign permission.
  if (input.assignedTo && input.assignedTo !== String(ctx.userId) && !ctx.permissions.has('crm.assign')) delete input.assignedTo;
  created(res, await crm.createLead(ctx, input));
});
crmRouter.get('/:id', authorize('crm.read'), validate({ params: idParam }), async (req, res) => ok(res, await crm.getLead(getCtx(req), params<Id>(req).id)));
crmRouter.patch('/:id', authorize('crm.update'), validate({ params: idParam, body: leadUpdateSchema }), async (req, res) =>
  ok(res, await crm.updateLead(getCtx(req), params<Id>(req).id, body<Partial<LeadInput>>(req))),
);
crmRouter.post('/:id/status', authorize('crm.update'), validate({ params: idParam, body: leadStatusSchema }), async (req, res) => {
  const b = body<{ status: LeadStatus; lostReason?: string }>(req);
  ok(res, await crm.changeLeadStatus(getCtx(req), params<Id>(req).id, b.status, b.lostReason));
});
crmRouter.post('/:id/activities', authorize('crm.update'), validate({ params: idParam, body: leadActivitySchema }), async (req, res) =>
  created(res, await crm.addActivity(getCtx(req), params<Id>(req).id, body<LeadActivityInput>(req))),
);
crmRouter.post('/:id/assign', authorize('crm.assign'), validate({ params: idParam, body: leadAssignSchema }), async (req, res) =>
  ok(res, await crm.assignLead(getCtx(req), params<Id>(req).id, body<{ assignedTo: string | null }>(req).assignedTo)),
);
crmRouter.post('/:id/convert', authorize('crm.update', 'customers.create'), validate({ params: idParam }), async (req, res) =>
  ok(res, await crm.convertLead(getCtx(req), params<Id>(req).id)),
);
crmRouter.delete('/:id', authorize('crm.delete'), validate({ params: idParam }), async (req, res) => {
  await crm.deleteLead(getCtx(req), params<Id>(req).id);
  ok(res, { deleted: true });
});
