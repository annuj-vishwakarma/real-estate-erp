import { model, Schema, type InferSchemaType } from 'mongoose';
import { EXPENSE_SETTLEMENTS, PAYMENT_MODES, VENDOR_CATEGORIES, WORK_ORDER_STATUSES } from '@erp/shared';
import { addressDef, baseOptions, tenantRef, withTenant } from '../../db/base';

/** Contractors and suppliers. Their payable balance is derived from tagged journal lines. */
const vendorSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      name: { type: String, required: true, trim: true },
      category: { type: String, enum: VENDOR_CATEGORIES, default: 'other' },
      phone: String,
      email: String,
      gstin: String,
      pan: String,
      address: addressDef,
      isActive: { type: Boolean, default: true },
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
vendorSchema.index({ companyId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
export type VendorDoc = InferSchemaType<typeof vendorSchema>;
export const Vendor = model('Vendor', vendorSchema);

const milestoneDef = new Schema(
  {
    name: { type: String, required: true },
    percentBp: Number,
    dueDate: Date,
    completedAt: Date,
  },
  { _id: true },
);

const workOrderSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true, immutable: true },
      vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true, immutable: true },
      number: { type: String, required: true, immutable: true },
      title: { type: String, required: true },
      scope: String,
      amountPaise: { type: Number, required: true, min: 1 },
      /** Sum of posted (non-reversed) bills against this order; never exceeds amountPaise. */
      billedPaise: { type: Number, default: 0, min: 0 },
      status: { type: String, enum: WORK_ORDER_STATUSES, default: 'draft', required: true },
      milestones: { type: [milestoneDef], default: [] },
      startDate: Date,
      endDate: Date,
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
workOrderSchema.index({ companyId: 1, number: 1 }, { unique: true });
workOrderSchema.index({ companyId: 1, projectId: 1, status: 1 });
workOrderSchema.index({ companyId: 1, vendorId: 1 });
export const WorkOrder = model('WorkOrder', workOrderSchema);

/** A vendor bill or direct expense. Posted to the books immediately; corrected by reversal. */
const expenseSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      number: { type: String, required: true, immutable: true },
      projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
      vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
      workOrderId: { type: Schema.Types.ObjectId, ref: 'WorkOrder' },
      expenseAccountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
      date: { type: Date, required: true },
      amountPaise: { type: Number, required: true, min: 1, immutable: true },
      description: { type: String, required: true },
      billNumber: String,
      settlement: { type: String, enum: EXPENSE_SETTLEMENTS, required: true },
      mode: { type: String, enum: PAYMENT_MODES },
      paidFromAccountId: { type: Schema.Types.ObjectId, ref: 'Account' },
      status: { type: String, enum: ['posted', 'reversed'], default: 'posted', required: true },
      journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      reversal: { reason: String, at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, journalEntryId: Schema.Types.ObjectId },
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
expenseSchema.index({ companyId: 1, number: 1 }, { unique: true });
expenseSchema.index({ companyId: 1, projectId: 1, date: -1 });
expenseSchema.index({ companyId: 1, vendorId: 1, date: -1 });
expenseSchema.index({ companyId: 1, workOrderId: 1 });
export const Expense = model('Expense', expenseSchema);

/** Payment to a vendor against their payable balance. */
const vendorPaymentSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      number: { type: String, required: true, immutable: true },
      vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
      projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
      amountPaise: { type: Number, required: true, min: 1, immutable: true },
      date: { type: Date, required: true },
      mode: { type: String, enum: PAYMENT_MODES, required: true },
      accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
      reference: String,
      remarks: String,
      journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
vendorPaymentSchema.index({ companyId: 1, number: 1 }, { unique: true });
vendorPaymentSchema.index({ companyId: 1, vendorId: 1, date: -1 });
export const VendorPayment = model('VendorPayment', vendorPaymentSchema);
