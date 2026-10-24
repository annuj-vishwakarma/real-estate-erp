import { createHash, randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { ALLOWED_UPLOAD_TYPES, type DocumentEntityType, type DocumentUploadInput, type Permission } from '@erp/shared';
import { env } from '../../config/env';
import { audit } from '../../utils/audit';
import { AppError, badRequest, forbidden, notFound } from '../../utils/errors';
import { canAccessProject, hasPermission, toObjectId, type TenantContext } from '../../utils/tenant';
import { Booking } from '../bookings/booking.models';
import { WorkOrder, Vendor } from '../construction/construction.models';
import { Lead } from '../crm/crm.models';
import { assertCustomerVisible } from '../customers/customers.service';
import { LandParcel } from '../land/land.model';
import { Payment } from '../payments/payment.models';
import { Plot } from '../plots/plot.models';
import { Project } from '../projects/project.models';
import { DocumentFile } from './document.model';
import { storage } from './storage';

/** Read permission for the record a document is attached to. */
const ENTITY_PERMISSION: Record<DocumentEntityType, Permission> = {
  project: 'projects.read',
  land_parcel: 'land.read',
  plot: 'inventory.read',
  customer: 'customers.read',
  booking: 'bookings.read',
  payment: 'payments.read',
  vendor: 'vendors.read',
  work_order: 'construction.read',
  lead: 'crm.read',
  company: 'company.read',
};

/**
 * Confirms the parent record exists in the caller's company, is inside their project scope
 * and that they may read that module. Returns the record's project (if any).
 */
export async function assertEntityAccess(ctx: TenantContext, entityType: DocumentEntityType, entityId: string): Promise<Types.ObjectId | null> {
  if (!hasPermission(ctx, ENTITY_PERMISSION[entityType])) throw forbidden();
  const id = toObjectId(entityId);
  const c = ctx.companyId;
  let projectId: Types.ObjectId | null | undefined = null;
  let found = true;
  switch (entityType) {
    case 'company':
      found = String(id) === String(c);
      break;
    case 'project':
      found = Boolean(await Project.exists({ companyId: c, _id: id }));
      projectId = id;
      break;
    case 'plot': {
      const r = await Plot.findOne({ companyId: c, _id: id }).select('projectId').lean();
      found = Boolean(r);
      projectId = r?.projectId;
      break;
    }
    case 'booking': {
      const r = await Booking.findOne({ companyId: c, _id: id }).select('projectId').lean();
      found = Boolean(r);
      projectId = r?.projectId;
      break;
    }
    case 'payment': {
      const r = await Payment.findOne({ companyId: c, _id: id }).select('projectId').lean();
      found = Boolean(r);
      projectId = r?.projectId;
      break;
    }
    case 'work_order': {
      const r = await WorkOrder.findOne({ companyId: c, _id: id }).select('projectId').lean();
      found = Boolean(r);
      projectId = r?.projectId;
      break;
    }
    case 'land_parcel': {
      const r = await LandParcel.findOne({ companyId: c, _id: id, deletedAt: null }).select('projectId').lean();
      found = Boolean(r);
      projectId = r?.projectId ?? null;
      // Unassigned parcels are company-level: restricted users cannot see them.
      if (r && !projectId && ctx.projectScope !== null) found = false;
      break;
    }
    case 'lead': {
      const r = await Lead.findOne({ companyId: c, _id: id, deletedAt: null }).select('projectId assignedTo createdBy').lean();
      found = Boolean(r);
      projectId = r?.projectId ?? null;
      if (r && ctx.projectScope !== null) {
        const mine = String(r.assignedTo) === String(ctx.userId) || String(r.createdBy) === String(ctx.userId);
        if (!mine && !(projectId && canAccessProject(ctx, projectId))) found = false;
        projectId = null; // visibility already decided
      }
      break;
    }
    case 'vendor':
      found = Boolean(await Vendor.exists({ companyId: c, _id: id }));
      break;
    case 'customer':
      await assertCustomerVisible(ctx, entityId);
      break;
  }
  if (!found) throw notFound('Record');
  if (projectId && !canAccessProject(ctx, projectId)) throw notFound('Record');
  return projectId ?? null;
}

/** Verifies the file's leading bytes match its declared type (defeats renamed executables, HTML, etc.). */
export function matchesSignature(buf: Buffer, mimeType: string): boolean {
  const startsWith = (...bytes: number[]) => bytes.every((b, i) => buf[i] === b);
  switch (mimeType) {
    case 'application/pdf':
      return buf.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/jpeg':
      return startsWith(0xff, 0xd8, 0xff);
    case 'image/webp':
      return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return startsWith(0x50, 0x4b, 0x03, 0x04) && buf.includes('word/');
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return startsWith(0x50, 0x4b, 0x03, 0x04) && buf.includes('xl/');
    default:
      return false;
  }
}

function safeFileName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  return (cleaned || 'file').slice(0, 180);
}

export interface UploadedFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export async function uploadDocument(ctx: TenantContext, input: DocumentUploadInput, file: UploadedFile | undefined) {
  if (!file) throw badRequest('Attach a file');
  if (file.size === 0) throw badRequest('The file is empty');
  if (file.size > env.MAX_UPLOAD_MB * 1024 * 1024) throw new AppError(413, 'VALIDATION_ERROR', `Files may be at most ${env.MAX_UPLOAD_MB} MB`);
  const ext = ALLOWED_UPLOAD_TYPES[file.mimetype];
  if (!ext) throw badRequest('Only PDF, PNG, JPEG, WebP, Word (.docx) and Excel (.xlsx) files are allowed');
  if (!matchesSignature(file.buffer, file.mimetype)) throw badRequest('The file contents do not match its type');

  const projectId = await assertEntityAccess(ctx, input.entityType, input.entityId);
  const storageKey = `${ctx.companyId}/${input.entityType}/${input.entityId}/${randomUUID()}.${ext}`;
  const checksumSha256 = createHash('sha256').update(file.buffer).digest('hex');
  await storage.put(storageKey, file.buffer, file.mimetype);

  const doc = await DocumentFile.create({
    companyId: ctx.companyId,
    projectId,
    entityType: input.entityType,
    entityId: toObjectId(input.entityId),
    category: input.category,
    description: input.description,
    fileName: safeFileName(file.originalname),
    mimeType: file.mimetype,
    sizeBytes: file.size,
    storageKey,
    checksumSha256,
    uploadedBy: ctx.userId,
  });
  await audit(ctx, {
    action: 'documents.upload',
    entityType: input.entityType,
    entityId: input.entityId,
    summary: `${doc.fileName} (${input.category})`,
    changes: { documentId: String(doc._id), sizeBytes: file.size, checksumSha256 },
  });
  return doc.toJSON();
}

export async function listDocuments(ctx: TenantContext, entityType: DocumentEntityType, entityId: string) {
  await assertEntityAccess(ctx, entityType, entityId);
  return DocumentFile.find({ companyId: ctx.companyId, entityType, entityId: toObjectId(entityId), deletedAt: null })
    .sort({ createdAt: -1 })
    .populate('uploadedBy', 'name')
    .lean();
}

/** Issues a short-lived signed URL after re-checking access to the parent record. */
export async function documentUrl(ctx: TenantContext, id: string, disposition: 'inline' | 'attachment') {
  const doc = await DocumentFile.findOne({ companyId: ctx.companyId, _id: toObjectId(id), deletedAt: null }).select('+storageKey').lean();
  if (!doc) throw notFound('Document');
  await assertEntityAccess(ctx, doc.entityType as DocumentEntityType, String(doc.entityId));
  const ttl = env.FILE_URL_TTL_SECONDS;
  const url = await storage.signedUrl(doc.storageKey, { fileName: doc.fileName, mimeType: doc.mimeType, ttlSeconds: ttl, disposition });
  await audit(ctx, { action: 'documents.download', entityType: doc.entityType, entityId: doc.entityId, summary: doc.fileName });
  return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString(), fileName: doc.fileName, mimeType: doc.mimeType };
}

/** Soft delete: metadata is hidden, the object is retained for audit/retention policies. */
export async function deleteDocument(ctx: TenantContext, id: string) {
  const doc = await DocumentFile.findOne({ companyId: ctx.companyId, _id: toObjectId(id), deletedAt: null }).lean();
  if (!doc) throw notFound('Document');
  await assertEntityAccess(ctx, doc.entityType as DocumentEntityType, String(doc.entityId));
  await DocumentFile.updateOne({ companyId: ctx.companyId, _id: doc._id }, { $set: { deletedAt: new Date(), deletedBy: ctx.userId } });
  await audit(ctx, { action: 'documents.delete', entityType: doc.entityType, entityId: doc.entityId, summary: doc.fileName });
}
