import { Router } from 'express';
import { z } from 'zod';
import {
  expenseListQuerySchema,
  expenseSchema,
  idParam,
  listQuerySchema,
  milestoneCompleteSchema,
  objectId,
  requiredText,
  VENDOR_CATEGORIES,
  vendorPaymentSchema,
  vendorSchema,
  workOrderListQuerySchema,
  workOrderSchema,
  workOrderStatusSchema,
  workOrderUpdateSchema,
  type ExpenseInput,
  type VendorInput,
  type VendorPaymentInput,
  type WorkOrderInput,
  type WorkOrderStatus,
} from '@erp/shared';
import { authorize } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { body, params, query, validate } from '../../middleware/validate';
import { created, ok } from '../../utils/http';
import { getCtx } from '../../utils/tenant';
import * as svc from './construction.service';

type Id = { id: string };

export const vendorsRouter = Router();
const vendorQuery = listQuerySchema.extend({
  category: z.enum(VENDOR_CATEGORIES).optional(),
  includeInactive: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});
vendorsRouter.get('/', authorize('vendors.read'), validate({ query: vendorQuery }), async (req, res) => {
  const { items, meta } = await svc.listVendors(getCtx(req), query(req));
  ok(res, items, meta);
});
vendorsRouter.post('/', authorize('vendors.create'), validate({ body: vendorSchema }), async (req, res) =>
  created(res, await svc.createVendor(getCtx(req), body<VendorInput>(req))),
);
vendorsRouter.get('/:id', authorize('vendors.read'), validate({ params: idParam }), async (req, res) => ok(res, await svc.getVendor(getCtx(req), params<Id>(req).id)));
vendorsRouter.patch('/:id', authorize('vendors.update'), validate({ params: idParam, body: vendorSchema.partial() }), async (req, res) =>
  ok(res, await svc.updateVendor(getCtx(req), params<Id>(req).id, body<Partial<VendorInput>>(req))),
);
vendorsRouter.post('/:id/payments', authorize('vendors.pay'), validate({ params: idParam, body: vendorPaymentSchema }), idempotent, async (req, res) =>
  created(res, await svc.payVendor(getCtx(req), params<Id>(req).id, body<VendorPaymentInput>(req))),
);

export const workOrdersRouter = Router();
workOrdersRouter.get('/', authorize('construction.read'), validate({ query: workOrderListQuerySchema }), async (req, res) => {
  const { items, meta } = await svc.listWorkOrders(getCtx(req), query(req));
  ok(res, items, meta);
});
workOrdersRouter.get('/costs', authorize('construction.read'), validate({ query: z.object({ projectId: objectId.optional() }) }), async (req, res) =>
  ok(res, await svc.projectCosts(getCtx(req), query<{ projectId?: string }>(req).projectId)),
);
workOrdersRouter.post('/', authorize('construction.create'), validate({ body: workOrderSchema }), async (req, res) =>
  created(res, await svc.createWorkOrder(getCtx(req), body<WorkOrderInput>(req))),
);
workOrdersRouter.get('/:id', authorize('construction.read'), validate({ params: idParam }), async (req, res) =>
  ok(res, await svc.getWorkOrder(getCtx(req), params<Id>(req).id)),
);
workOrdersRouter.patch('/:id', authorize('construction.update'), validate({ params: idParam, body: workOrderUpdateSchema }), async (req, res) =>
  ok(res, await svc.updateWorkOrder(getCtx(req), params<Id>(req).id, body(req))),
);
workOrdersRouter.post('/:id/status', authorize('construction.update'), validate({ params: idParam, body: workOrderStatusSchema }), async (req, res) => {
  const b = body<{ status: WorkOrderStatus; note?: string }>(req);
  ok(res, await svc.changeWorkOrderStatus(getCtx(req), params<Id>(req).id, b.status, b.note));
});
workOrdersRouter.post(
  '/:id/milestones/:milestoneId',
  authorize('construction.update'),
  validate({ params: z.object({ id: objectId, milestoneId: objectId }), body: milestoneCompleteSchema }),
  async (req, res) => {
    const p = params<{ id: string; milestoneId: string }>(req);
    const b = body<{ completed: boolean; date?: string }>(req);
    ok(res, await svc.setMilestone(getCtx(req), p.id, p.milestoneId, b.completed, b.date));
  },
);

export const expensesRouter = Router();
expensesRouter.get('/', authorize('expenses.read'), validate({ query: expenseListQuerySchema }), async (req, res) => {
  const { items, meta, totalPaise } = await svc.listExpenses(getCtx(req), query(req));
  res.setHeader('x-total-amount', String(totalPaise));
  ok(res, items, meta);
});
expensesRouter.post('/', authorize('expenses.create'), validate({ body: expenseSchema }), idempotent, async (req, res) =>
  created(res, await svc.createExpense(getCtx(req), body<ExpenseInput>(req))),
);
expensesRouter.post('/:id/reverse', authorize('expenses.reverse'), validate({ params: idParam, body: z.object({ reason: requiredText('Reason', 500) }) }), async (req, res) =>
  ok(res, await svc.reverseExpense(getCtx(req), params<Id>(req).id, body<{ reason: string }>(req).reason)),
);
