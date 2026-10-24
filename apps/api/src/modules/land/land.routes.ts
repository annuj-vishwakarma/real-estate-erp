import { Router } from 'express';
import {
  idParam,
  landListQuerySchema,
  landParcelSchema,
  landParcelUpdateSchema,
  landPaymentSchema,
  landStatusSchema,
  type LandParcelInput,
  type LandPaymentInput,
  type LandStatus,
} from '@erp/shared';
import { authorize } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { body, params, query, validate } from '../../middleware/validate';
import { created, ok } from '../../utils/http';
import { getCtx } from '../../utils/tenant';
import * as land from './land.service';

export const landRouter = Router();
type Id = { id: string };

landRouter.get('/', authorize('land.read'), validate({ query: landListQuerySchema }), async (req, res) => {
  const { items, meta } = await land.listParcels(getCtx(req), query(req));
  ok(res, items, meta);
});
landRouter.get('/summary', authorize('land.read'), validate({ query: landListQuerySchema }), async (req, res) => {
  const { totals } = await land.listParcels(getCtx(req), { ...query<{ page: number }>(req), page: 1, pageSize: 1 });
  ok(res, totals);
});
landRouter.post('/', authorize('land.create'), validate({ body: landParcelSchema }), async (req, res) =>
  created(res, await land.createParcel(getCtx(req), body<LandParcelInput>(req))),
);
landRouter.get('/:id', authorize('land.read'), validate({ params: idParam }), async (req, res) => ok(res, await land.getParcel(getCtx(req), params<Id>(req).id)));
landRouter.patch('/:id', authorize('land.update'), validate({ params: idParam, body: landParcelUpdateSchema }), async (req, res) =>
  ok(res, await land.updateParcel(getCtx(req), params<Id>(req).id, body<Partial<LandParcelInput>>(req))),
);
landRouter.post('/:id/status', authorize('land.update'), validate({ params: idParam, body: landStatusSchema }), async (req, res) => {
  const b = body<{ status: LandStatus; date?: string; note?: string }>(req);
  ok(res, await land.changeStatus(getCtx(req), params<Id>(req).id, b.status, b.date, b.note));
});
landRouter.post('/:id/payments', authorize('land.pay'), validate({ params: idParam, body: landPaymentSchema }), idempotent, async (req, res) =>
  created(res, await land.recordLandPayment(getCtx(req), params<Id>(req).id, body<LandPaymentInput>(req))),
);
landRouter.delete('/:id', authorize('land.delete'), validate({ params: idParam }), async (req, res) => {
  await land.deleteParcel(getCtx(req), params<Id>(req).id);
  ok(res, { deleted: true });
});
