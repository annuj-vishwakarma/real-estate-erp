import { Router } from 'express';
import { z } from 'zod';
import { brokerPayoutSchema, brokerSchema, idParam, type BrokerInput, type BrokerPayoutInput } from '@erp/shared';
import { authorize } from '../../middleware/auth';
import { idempotent } from '../../middleware/idempotency';
import { body, params, query, validate } from '../../middleware/validate';
import { created, ok } from '../../utils/http';
import { getCtx } from '../../utils/tenant';
import * as brokers from './brokers.service';

export const brokersRouter = Router();
type Id = { id: string };

brokersRouter.get(
  '/',
  authorize('brokers.read'),
  validate({ query: z.object({ q: z.string().trim().max(60).optional(), includeInactive: z.enum(['true', 'false']).optional() }) }),
  async (req, res) => {
    const q = query<{ q?: string; includeInactive?: string }>(req);
    ok(res, await brokers.listBrokers(getCtx(req), q.q, q.includeInactive === 'true'));
  },
);
brokersRouter.post('/', authorize('brokers.create'), validate({ body: brokerSchema }), async (req, res) =>
  created(res, await brokers.createBroker(getCtx(req), body<BrokerInput>(req))),
);
brokersRouter.get('/:id', authorize('brokers.read'), validate({ params: idParam }), async (req, res) => ok(res, await brokers.getBroker(getCtx(req), params<Id>(req).id)));
brokersRouter.patch('/:id', authorize('brokers.update'), validate({ params: idParam, body: brokerSchema.partial() }), async (req, res) =>
  ok(res, await brokers.updateBroker(getCtx(req), params<Id>(req).id, body<Partial<BrokerInput>>(req))),
);
brokersRouter.post('/:id/payouts', authorize('brokers.payout'), validate({ params: idParam, body: brokerPayoutSchema }), idempotent, async (req, res) =>
  created(res, await brokers.payoutCommissions(getCtx(req), params<Id>(req).id, body<BrokerPayoutInput>(req))),
);
