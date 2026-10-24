import { Router } from 'express';
import { z } from 'zod';
import {
  bookingListQuerySchema,
  cancelBookingSchema,
  createBookingSchema,
  customerSchema,
  customerUpdateSchema,
  email,
  idParam,
  listQuerySchema,
  objectId,
  optional,
  paymentListQuerySchema,
  paymentPlanSchema,
  phone,
  quoteSchema,
  recordPaymentSchema,
  refundSchema,
  requiredText,
  reversePaymentSchema,
  trimmed,
  type CancelBookingInput,
  type CreateBookingInput,
  type CustomerInput,
  type ListQuery,
  type PaymentPlanInput,
  type QuoteInput,
  type RecordPaymentInput,
  type RefundInput,
} from '@erp/shared';
import { authorize } from '../middleware/auth';
import { idempotent } from '../middleware/idempotency';
import { body, params, query, validate } from '../middleware/validate';
import { created, ok } from '../utils/http';
import { getCtx } from '../utils/tenant';
import * as bookings from './bookings/bookings.service';
import * as plans from './bookings/payment-plans.service';
import * as customers from './customers/customers.service';
import * as payments from './payments/payments.service';
import { allotmentLetterPdf, exportBookings, exportPayments, receiptPdf } from './reports/documents.service';

type Id = { id: string };
const projectQuery = z.object({ projectId: objectId.optional() });

// ---------------- Customers ----------------
export const customersRouter = Router();
customersRouter.get('/', authorize('customers.read'), validate({ query: listQuerySchema }), async (req, res) => {
  const { items, meta } = await customers.listCustomers(getCtx(req), query<ListQuery>(req));
  ok(res, items, meta);
});
customersRouter.post('/', authorize('customers.create'), validate({ body: customerSchema }), async (req, res) =>
  created(res, await customers.createCustomer(getCtx(req), body<CustomerInput>(req))),
);
customersRouter.get('/:id', authorize('customers.read'), validate({ params: idParam }), async (req, res) =>
  ok(res, await customers.getCustomer(getCtx(req), params<Id>(req).id)),
);
customersRouter.patch('/:id', authorize('customers.update'), validate({ params: idParam, body: customerUpdateSchema }), async (req, res) =>
  ok(res, await customers.updateCustomer(getCtx(req), params<Id>(req).id, body<Partial<CustomerInput>>(req))),
);
customersRouter.delete('/:id', authorize('customers.delete'), validate({ params: idParam }), async (req, res) => {
  await customers.deleteCustomer(getCtx(req), params<Id>(req).id);
  ok(res, { deleted: true });
});
customersRouter.get('/:id/ledger', authorize('customers.read', 'payments.read'), validate({ params: idParam }), async (req, res) =>
  ok(res, await customers.customerLedger(getCtx(req), params<Id>(req).id)),
);

// ---------------- Payment plans ----------------
export const plansRouter = Router();
plansRouter.get('/', authorize('paymentPlans.read'), validate({ query: projectQuery }), async (req, res) =>
  ok(res, await plans.listPlans(getCtx(req), query<{ projectId?: string }>(req).projectId)),
);
plansRouter.post('/', authorize('paymentPlans.create'), validate({ body: paymentPlanSchema }), async (req, res) =>
  created(res, await plans.createPlan(getCtx(req), body<PaymentPlanInput>(req))),
);
plansRouter.put('/:id', authorize('paymentPlans.update'), validate({ params: idParam, body: paymentPlanSchema }), async (req, res) =>
  ok(res, await plans.updatePlan(getCtx(req), params<Id>(req).id, body<PaymentPlanInput>(req))),
);

// ---------------- Bookings ----------------
export const bookingsRouter = Router();
const bookingQuery = bookingListQuerySchema.extend({ projectId: objectId.optional() });
type BookingQuery = z.infer<typeof bookingQuery>;

bookingsRouter.get('/', authorize('bookings.read'), validate({ query: bookingQuery }), async (req, res) => {
  const q = query<BookingQuery>(req);
  const { items, meta } = await bookings.listBookings(getCtx(req), q, q.projectId);
  ok(res, items, meta);
});
bookingsRouter.get('/export.xlsx', authorize('bookings.read', 'reports.export'), validate({ query: bookingQuery }), async (req, res) => {
  const q = query<BookingQuery>(req);
  await exportBookings(getCtx(req), q, q.projectId, res);
});
bookingsRouter.post('/quote', authorize('bookings.read'), validate({ body: quoteSchema }), async (req, res) =>
  ok(res, await bookings.quote(getCtx(req), body<QuoteInput>(req))),
);
bookingsRouter.post('/', authorize('bookings.create'), validate({ body: createBookingSchema }), idempotent, async (req, res) =>
  created(res, await bookings.createBooking(getCtx(req), body<CreateBookingInput>(req))),
);
bookingsRouter.get('/:id', authorize('bookings.read'), validate({ params: idParam }), async (req, res) =>
  ok(res, await bookings.getBooking(getCtx(req), params<Id>(req).id)),
);
bookingsRouter.get('/:id/allotment.pdf', authorize('bookings.read'), validate({ params: idParam }), async (req, res) => {
  await allotmentLetterPdf(getCtx(req), params<Id>(req).id, res);
});
bookingsRouter.post('/:id/confirm', authorize('bookings.confirm'), validate({ params: idParam }), async (req, res) =>
  ok(res, await bookings.confirmBooking(getCtx(req), params<Id>(req).id)),
);
bookingsRouter.post(
  '/:id/cancel',
  authorize('bookings.cancel'),
  validate({ params: idParam, body: cancelBookingSchema }),
  async (req, res) => ok(res, await bookings.cancelBooking(getCtx(req), params<Id>(req).id, body<CancelBookingInput>(req))),
);
bookingsRouter.post(
  '/:id/refunds',
  authorize('payments.refund'),
  validate({ params: idParam, body: refundSchema }),
  idempotent,
  async (req, res) => created(res, await payments.refundBooking(getCtx(req), params<Id>(req).id, body<RefundInput>(req))),
);

// ---------------- Payments ----------------
export const paymentsRouter = Router();
const paymentQuery = paymentListQuerySchema.extend({ projectId: objectId.optional() });
type PaymentQuery = z.infer<typeof paymentQuery>;

paymentsRouter.get('/', authorize('payments.read'), validate({ query: paymentQuery }), async (req, res) => {
  const q = query<PaymentQuery>(req);
  const { items, meta } = await payments.listPayments(getCtx(req), q, q.projectId);
  ok(res, items, meta);
});
paymentsRouter.get('/export.xlsx', authorize('payments.read', 'reports.export'), validate({ query: paymentQuery }), async (req, res) => {
  const q = query<PaymentQuery>(req);
  await exportPayments(getCtx(req), q, q.projectId, res);
});
paymentsRouter.post('/', authorize('payments.create'), validate({ body: recordPaymentSchema }), idempotent, async (req, res) =>
  created(res, await payments.recordPayment(getCtx(req), body<RecordPaymentInput>(req))),
);
paymentsRouter.get('/:id', authorize('payments.read'), validate({ params: idParam }), async (req, res) =>
  ok(res, await payments.getPayment(getCtx(req), params<Id>(req).id)),
);
paymentsRouter.get('/:id/receipt.pdf', authorize('payments.read'), validate({ params: idParam }), async (req, res) => {
  await receiptPdf(getCtx(req), params<Id>(req).id, res);
});
paymentsRouter.post(
  '/:id/reverse',
  authorize('payments.reverse'),
  validate({ params: idParam, body: reversePaymentSchema }),
  async (req, res) => ok(res, await payments.reversePayment(getCtx(req), params<Id>(req).id, body<{ reason: string }>(req).reason)),
);
