import { model, Schema } from 'mongoose';
import { LEAD_SOURCES, LEAD_STATUSES } from '@erp/shared';
import { baseOptions, tenantRef, withTenant } from '../../db/base';

/** CRM lead (Phase 2 module). */
const leadSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
      name: { type: String, required: true, trim: true },
      phone: { type: String, required: true },
      email: String,
      source: { type: String, enum: LEAD_SOURCES, default: 'other' },
      brokerId: { type: Schema.Types.ObjectId, ref: 'Broker' },
      status: { type: String, enum: LEAD_STATUSES, default: 'new', required: true },
      budgetMinPaise: Number,
      budgetMaxPaise: Number,
      interestedPlotIds: [{ type: Schema.Types.ObjectId, ref: 'Plot' }],
      assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
      nextFollowUpAt: Date,
      lostReason: String,
      customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
      convertedAt: Date,
      notes: String,
      lastActivityAt: Date,
      lastReminderOn: Date,
      createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
      deletedAt: Date,
    },
    baseOptions,
  ),
);
leadSchema.index({ companyId: 1, status: 1, nextFollowUpAt: 1 });
leadSchema.index({ companyId: 1, assignedTo: 1, status: 1 });
leadSchema.index({ companyId: 1, phone: 1 });
leadSchema.index({ companyId: 1, projectId: 1, status: 1, createdAt: -1 });
leadSchema.index({ status: 1, nextFollowUpAt: 1 });
export const Lead = model('Lead', leadSchema);

const leadActivitySchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      leadId: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
      type: { type: String, enum: ['call', 'whatsapp', 'email', 'meeting', 'site_visit', 'note', 'status_change'], required: true },
      summary: { type: String, required: true },
      outcome: String,
      scheduledAt: Date,
      completedAt: Date,
      actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    },
    baseOptions,
  ),
);
leadActivitySchema.index({ companyId: 1, leadId: 1, createdAt: -1 });
export const LeadActivity = model('LeadActivity', leadActivitySchema);
