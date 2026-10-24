import { model, Schema } from 'mongoose';
import { DOCUMENT_CATEGORIES, DOCUMENT_ENTITY_TYPES } from '@erp/shared';
import { baseOptions, tenantRef, withTenant } from '../../db/base';

/**
 * Document metadata. Only the private object-storage key is stored (never a public URL);
 * downloads always go through an authorized endpoint that issues a short-lived signed URL.
 */
const documentSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
      entityType: { type: String, enum: DOCUMENT_ENTITY_TYPES, required: true },
      entityId: { type: Schema.Types.ObjectId, required: true },
      category: { type: String, enum: DOCUMENT_CATEGORIES, default: 'general' },
      description: String,
      fileName: { type: String, required: true },
      mimeType: { type: String, required: true },
      sizeBytes: { type: Number, required: true, min: 1 },
      storageKey: { type: String, required: true, select: false },
      checksumSha256: String,
      uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
      deletedAt: Date,
      deletedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
documentSchema.index({ companyId: 1, entityType: 1, entityId: 1, createdAt: -1 });
export const DocumentFile = model('Document', documentSchema);
