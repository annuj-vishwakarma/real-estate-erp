import { model, Schema, type InferSchemaType } from 'mongoose';
import { LAND_AREA_UNITS, LAND_STATUSES, PAYMENT_MODES } from '@erp/shared';
import { baseOptions, tenantRef, withTenant } from '../../db/base';

/** Land acquisition record: survey identity, owners, deal status and cost. */
const landParcelSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      projectId: { type: Schema.Types.ObjectId, ref: 'Project', default: null },
      khasraNumber: { type: String, required: true, trim: true },
      khataNumber: String,
      village: { type: String, required: true, trim: true },
      tehsil: String,
      district: { type: String, required: true, trim: true },
      state: { type: String, required: true },
      areaX100: { type: Number, required: true, min: 1 },
      areaUnit: { type: String, enum: LAND_AREA_UNITS, default: 'sqft' },
      owners: [{ name: { type: String, required: true }, sharePercentBp: Number, phone: String }],
      status: { type: String, enum: LAND_STATUSES, default: 'negotiation', required: true },
      statusHistory: [
        {
          from: String,
          to: { type: String, required: true },
          note: String,
          at: { type: Date, default: Date.now },
          by: { type: Schema.Types.ObjectId, ref: 'User' },
        },
      ],
      agreedCostPaise: { type: Number, min: 0 },
      /** Running total of non-reversed payments to owners, maintained transactionally. */
      paidPaise: { type: Number, min: 0, default: 0 },
      agreementDate: Date,
      registryDate: Date,
      mutationDone: { type: Boolean, default: false },
      notes: String,
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
      deletedAt: Date,
    },
    baseOptions,
  ),
);
landParcelSchema.index({ companyId: 1, district: 1, village: 1, khasraNumber: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });
landParcelSchema.index({ companyId: 1, projectId: 1, status: 1 });
export type LandParcelDoc = InferSchemaType<typeof landParcelSchema>;
export const LandParcel = model('LandParcel', landParcelSchema);

/** Payment to land owners. Capitalised: Dr Land & Development (WIP), Cr Cash/Bank. */
const landPaymentSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      number: { type: String, required: true, immutable: true },
      landParcelId: { type: Schema.Types.ObjectId, ref: 'LandParcel', required: true },
      projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
      amountPaise: { type: Number, required: true, min: 1, immutable: true },
      date: { type: Date, required: true },
      mode: { type: String, enum: PAYMENT_MODES, required: true },
      accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
      payee: String,
      reference: String,
      remarks: String,
      journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
landPaymentSchema.index({ companyId: 1, number: 1 }, { unique: true });
landPaymentSchema.index({ companyId: 1, landParcelId: 1, date: 1 });
export const LandPayment = model('LandPayment', landPaymentSchema);
