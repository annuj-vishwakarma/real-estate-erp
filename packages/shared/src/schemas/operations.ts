import { z } from 'zod';
import {
  DOCUMENT_CATEGORIES,
  DOCUMENT_ENTITY_TYPES,
  EXPENSE_SETTLEMENTS,
  LAND_AREA_UNITS,
  LAND_STATUSES,
  LEAD_ACTIVITY_TYPES,
  LEAD_SOURCES,
  LEAD_STATUSES,
  PAYMENT_MODES,
  VENDOR_CATEGORIES,
  WORK_ORDER_STATUSES,
} from '../constants/status';
import {
  addressSchema,
  basisPoints,
  email,
  gstin,
  isoDate,
  listQuerySchema,
  objectId,
  optional,
  paise,
  pan,
  phone,
  positivePaise,
  requiredText,
  trimmed,
} from './common';

// ---------------- Land acquisition ----------------
export const landOwnerSchema = z.object({
  name: requiredText('Owner name', 120),
  sharePercentBp: basisPoints.optional(),
  phone: optional(phone),
});

export const landParcelSchema = z.object({
  projectId: optional(objectId),
  khasraNumber: requiredText('Khasra number', 40),
  khataNumber: trimmed(40).optional(),
  village: requiredText('Village', 100),
  tehsil: trimmed(100).optional(),
  district: requiredText('District', 100),
  state: requiredText('State', 100),
  /** Area in hundredths of the chosen unit. */
  areaX100: z.number().int().positive('Area must be greater than zero'),
  areaUnit: z.enum(LAND_AREA_UNITS).default('sqft'),
  owners: z.array(landOwnerSchema).max(20).default([]),
  agreedCostPaise: paise.optional(),
  agreementDate: optional(isoDate),
  registryDate: optional(isoDate),
  mutationDone: z.boolean().default(false),
  notes: trimmed(2000).optional(),
});
export type LandParcelInput = z.infer<typeof landParcelSchema>;
export const landParcelUpdateSchema = landParcelSchema.partial();

export const landStatusSchema = z.object({
  status: z.enum(LAND_STATUSES),
  date: optional(isoDate),
  note: trimmed(300).optional(),
});

export const landPaymentSchema = z.object({
  amountPaise: positivePaise,
  paidOn: isoDate,
  mode: z.enum(PAYMENT_MODES),
  fromAccountId: optional(objectId),
  payee: trimmed(120).optional(),
  reference: trimmed(100).optional(),
  remarks: trimmed(500).optional(),
});
export type LandPaymentInput = z.infer<typeof landPaymentSchema>;

export const landListQuerySchema = listQuerySchema.extend({
  status: z.enum(LAND_STATUSES).optional(),
  projectId: objectId.optional(),
});

// ---------------- CRM ----------------
export const leadSchema = z.object({
  projectId: optional(objectId),
  name: requiredText('Name', 120),
  phone,
  email: optional(email),
  source: z.enum(LEAD_SOURCES).default('other'),
  brokerId: optional(objectId),
  budgetMinPaise: paise.optional(),
  budgetMaxPaise: paise.optional(),
  interestedPlotIds: z.array(objectId).max(20).default([]),
  assignedTo: optional(objectId),
  nextFollowUpAt: optional(z.string().datetime({ offset: true })),
  notes: trimmed(2000).optional(),
});
export type LeadInput = z.infer<typeof leadSchema>;
export const leadUpdateSchema = leadSchema.partial();

export const leadStatusSchema = z
  .object({
    status: z.enum(LEAD_STATUSES),
    lostReason: trimmed(300).optional(),
  })
  .refine((v) => v.status !== 'lost' || (v.lostReason && v.lostReason.length > 0), {
    path: ['lostReason'],
    message: 'Give a reason for losing the lead',
  });

export const leadActivitySchema = z.object({
  type: z.enum(LEAD_ACTIVITY_TYPES).exclude(['status_change']),
  summary: requiredText('Summary', 1000),
  outcome: trimmed(300).optional(),
  /** Schedules the next follow-up on the lead. */
  nextFollowUpAt: optional(z.string().datetime({ offset: true })),
});
export type LeadActivityInput = z.infer<typeof leadActivitySchema>;

export const leadAssignSchema = z.object({ assignedTo: objectId.nullable() });

export const leadListQuerySchema = listQuerySchema.extend({
  status: z.enum(LEAD_STATUSES).optional(),
  source: z.enum(LEAD_SOURCES).optional(),
  projectId: objectId.optional(),
  assignedTo: z.union([objectId, z.literal('me'), z.literal('unassigned')]).optional(),
  followUp: z.enum(['due', 'upcoming']).optional(),
});

// ---------------- Brokers ----------------
export const brokerSchema = z.object({
  name: requiredText('Name', 120),
  phone,
  email: optional(email),
  pan: optional(pan),
  firmName: trimmed(120).optional(),
  commissionBp: basisPoints.default(0),
  isActive: z.boolean().default(true),
});
export type BrokerInput = z.infer<typeof brokerSchema>;

export const brokerPayoutSchema = z.object({
  commissionIds: z.array(objectId).min(1, 'Select at least one commission').max(200),
  paidOn: isoDate,
  mode: z.enum(PAYMENT_MODES),
  fromAccountId: optional(objectId),
  reference: trimmed(100).optional(),
});
export type BrokerPayoutInput = z.infer<typeof brokerPayoutSchema>;

// ---------------- Vendors, work orders, expenses ----------------
export const vendorSchema = z.object({
  name: requiredText('Vendor name', 150),
  category: z.enum(VENDOR_CATEGORIES).default('other'),
  phone: optional(phone),
  email: optional(email),
  gstin: optional(gstin),
  pan: optional(pan),
  address: addressSchema.optional(),
  isActive: z.boolean().default(true),
});
export type VendorInput = z.infer<typeof vendorSchema>;

export const milestoneSchema = z.object({
  name: requiredText('Milestone name', 120),
  percentBp: basisPoints.optional(),
  dueDate: optional(isoDate),
});

export const workOrderSchema = z.object({
  projectId: objectId,
  vendorId: objectId,
  title: requiredText('Title', 200),
  scope: trimmed(4000).optional(),
  amountPaise: positivePaise,
  startDate: optional(isoDate),
  endDate: optional(isoDate),
  milestones: z.array(milestoneSchema).max(50).default([]),
});
export type WorkOrderInput = z.infer<typeof workOrderSchema>;
export const workOrderUpdateSchema = workOrderSchema.omit({ projectId: true, vendorId: true }).partial();
export const workOrderStatusSchema = z.object({ status: z.enum(WORK_ORDER_STATUSES), note: trimmed(300).optional() });
export const milestoneCompleteSchema = z.object({ completed: z.boolean(), date: optional(isoDate) });

export const workOrderListQuerySchema = listQuerySchema.extend({
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  projectId: objectId.optional(),
  vendorId: objectId.optional(),
});

export const expenseSchema = z
  .object({
    projectId: optional(objectId),
    vendorId: optional(objectId),
    workOrderId: optional(objectId),
    /** An expense account, or the Land & Development (WIP) asset for capitalised costs. */
    expenseAccountId: objectId,
    date: isoDate,
    amountPaise: positivePaise,
    description: requiredText('Description', 500),
    billNumber: trimmed(60).optional(),
    /** `paid` settles now from cash/bank; `payable` books a vendor payable. */
    settlement: z.enum(EXPENSE_SETTLEMENTS),
    mode: z.enum(PAYMENT_MODES).optional(),
    paidFromAccountId: optional(objectId),
  })
  .refine((v) => v.settlement !== 'payable' || Boolean(v.vendorId), {
    path: ['vendorId'],
    message: 'Choose the vendor this bill is payable to',
  });
export type ExpenseInput = z.infer<typeof expenseSchema>;

export const expenseListQuerySchema = listQuerySchema.extend({
  projectId: objectId.optional(),
  vendorId: objectId.optional(),
  workOrderId: objectId.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

export const vendorPaymentSchema = z.object({
  amountPaise: positivePaise,
  paidOn: isoDate,
  mode: z.enum(PAYMENT_MODES),
  fromAccountId: optional(objectId),
  projectId: optional(objectId),
  reference: trimmed(100).optional(),
  remarks: trimmed(500).optional(),
});
export type VendorPaymentInput = z.infer<typeof vendorPaymentSchema>;

// ---------------- Documents ----------------
export const documentUploadSchema = z.object({
  entityType: z.enum(DOCUMENT_ENTITY_TYPES),
  entityId: objectId,
  category: z.enum(DOCUMENT_CATEGORIES).default('general'),
  description: trimmed(300).optional(),
});
export type DocumentUploadInput = z.infer<typeof documentUploadSchema>;

export const documentListQuerySchema = z.object({
  entityType: z.enum(DOCUMENT_ENTITY_TYPES),
  entityId: objectId,
});
