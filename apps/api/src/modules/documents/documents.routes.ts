import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { documentListQuerySchema, documentUploadSchema, idParam, type DocumentEntityType, type DocumentUploadInput } from '@erp/shared';
import { env } from '../../config/env';
import { authorize } from '../../middleware/auth';
import { params, query, validate } from '../../middleware/validate';
import { AppError } from '../../utils/errors';
import { created, ok } from '../../utils/http';
import { getCtx } from '../../utils/tenant';
import * as docs from './documents.service';
import { contentDisposition, localDriver, verifyFileToken } from './storage';

/** In-memory upload with hard limits; contents are type-checked before anything is stored. */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 10, fieldSize: 2048 },
});

export const documentsRouter = Router();

documentsRouter.get('/', authorize('documents.read'), validate({ query: documentListQuerySchema }), async (req, res) => {
  const q = query<{ entityType: DocumentEntityType; entityId: string }>(req);
  ok(res, await docs.listDocuments(getCtx(req), q.entityType, q.entityId));
});

documentsRouter.post(
  '/',
  authorize('documents.upload'),
  (req, res, next) =>
    upload.single('file')(req, res, (err: unknown) => {
      if ((err as { code?: string })?.code === 'LIMIT_FILE_SIZE') return next(new AppError(413, 'VALIDATION_ERROR', `Files may be at most ${env.MAX_UPLOAD_MB} MB`));
      if (err) return next(new AppError(400, 'VALIDATION_ERROR', 'Upload a single file in the "file" field'));
      next();
    }),
  async (req, res) => {
    const input = documentUploadSchema.parse(req.body) as DocumentUploadInput;
    created(res, await docs.uploadDocument(getCtx(req), input, req.file));
  },
);

documentsRouter.get(
  '/:id/url',
  authorize('documents.read'),
  validate({ params: idParam, query: z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') }) }),
  async (req, res) => ok(res, await docs.documentUrl(getCtx(req), params<{ id: string }>(req).id, query<{ disposition: 'inline' | 'attachment' }>(req).disposition)),
);

documentsRouter.delete('/:id', authorize('documents.delete'), validate({ params: idParam }), async (req, res) => {
  await docs.deleteDocument(getCtx(req), params<{ id: string }>(req).id);
  ok(res, { deleted: true });
});

/**
 * Public file endpoint for the local storage driver. The HMAC-signed, expiring token is the
 * authorization (issued only by GET /documents/:id/url after an access check).
 */
export const filesRouter = Router();
filesRouter.get('/:token', async (req, res) => {
  const payload = verifyFileToken(req.params.token);
  if (!payload) throw new AppError(403, 'FORBIDDEN', 'This link is invalid or has expired');
  const body = await localDriver.read(payload.k).catch(() => null);
  if (!body) throw new AppError(404, 'NOT_FOUND', 'File not found');
  res.setHeader('Content-Type', payload.t);
  res.setHeader('Content-Disposition', contentDisposition(payload.n, payload.d));
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.send(body);
});
