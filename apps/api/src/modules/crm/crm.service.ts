import { Types } from 'mongoose';
import { OPEN_LEAD_STATUSES, type LeadActivityInput, type LeadInput, type LeadStatus } from '@erp/shared';
import { nextSequence } from '../../db/system.models';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../utils/audit';
import { badRequest, businessRule, notFound } from '../../utils/errors';
import { escapeRegex, pageMeta, parseSort } from '../../utils/http';
import { assertProjectAccess, toObjectId, type TenantContext } from '../../utils/tenant';
import { Broker, Customer } from '../customers/customer.models';
import { Notification } from '../notifications/notification.model';
import { Plot } from '../plots/plot.models';
import { Project } from '../projects/project.models';
import { Membership } from '../users/user.models';
import { Lead, LeadActivity } from './crm.models';

/** Restricted users see leads of their projects, plus leads assigned to or created by them. */
function visibility(ctx: TenantContext): Record<string, unknown> {
  const f: Record<string, unknown> = { companyId: ctx.companyId, deletedAt: null };
  if (ctx.projectScope !== null) f.$or = [{ projectId: { $in: ctx.projectScope } }, { assignedTo: ctx.userId }, { createdBy: ctx.userId }];
  return f;
}

async function loadLead(ctx: TenantContext, id: string) {
  const lead = await Lead.findOne({ ...visibility(ctx), _id: toObjectId(id) });
  if (!lead) throw notFound('Lead');
  return lead;
}

async function validateRefs(ctx: TenantContext, input: Partial<LeadInput>) {
  const c = ctx.companyId;
  if (input.projectId) {
    assertProjectAccess(ctx, input.projectId);
    if (!(await Project.exists({ companyId: c, _id: toObjectId(input.projectId) }))) throw badRequest('Project not found');
  }
  if (input.brokerId && !(await Broker.exists({ companyId: c, _id: toObjectId(input.brokerId) }))) throw badRequest('Broker not found');
  if (input.assignedTo && !(await Membership.exists({ companyId: c, userId: toObjectId(input.assignedTo), status: 'active' }))) {
    throw badRequest('Assignee is not an active member of this company');
  }
  if (input.interestedPlotIds?.length) {
    if (!input.projectId) throw badRequest('Choose the project for the plots of interest');
    const n = await Plot.countDocuments({ companyId: c, projectId: toObjectId(input.projectId), _id: { $in: input.interestedPlotIds.map(toObjectId) } });
    if (n !== input.interestedPlotIds.length) throw badRequest('Some plots do not belong to the project');
  }
}

function normalize(input: Partial<LeadInput>) {
  const out: Record<string, unknown> = { ...input };
  if (input.nextFollowUpAt) out.nextFollowUpAt = new Date(input.nextFollowUpAt);
  if (input.interestedPlotIds) out.interestedPlotIds = input.interestedPlotIds.map(toObjectId);
  return out;
}

async function logActivity(ctx: TenantContext, leadId: Types.ObjectId, type: string, summary: string, extra: Record<string, unknown> = {}) {
  await LeadActivity.create({ companyId: ctx.companyId, leadId, type, summary, actorId: ctx.userId, completedAt: new Date(), ...extra });
}

async function notifyAssignee(ctx: TenantContext, lead: { _id: Types.ObjectId; name: string }, assignee: Types.ObjectId) {
  if (String(assignee) === String(ctx.userId)) return;
  await Notification.create({
    companyId: ctx.companyId,
    userId: assignee,
    type: 'lead_assigned',
    title: `New lead assigned: ${lead.name}`,
    link: `/crm?lead=${lead._id}`,
  });
}

export interface LeadListQuery {
  page: number;
  pageSize: number;
  sort?: string;
  q?: string;
  status?: string;
  source?: string;
  projectId?: string;
  assignedTo?: string;
  followUp?: 'due' | 'upcoming';
}

export async function listLeads(ctx: TenantContext, q: LeadListQuery) {
  const and: Record<string, unknown>[] = [visibility(ctx)];
  if (q.projectId) {
    assertProjectAccess(ctx, q.projectId);
    and.push({ projectId: toObjectId(q.projectId) });
  }
  if (q.status) and.push({ status: q.status });
  if (q.source) and.push({ source: q.source });
  if (q.assignedTo === 'me') and.push({ assignedTo: ctx.userId });
  else if (q.assignedTo === 'unassigned') and.push({ assignedTo: null });
  else if (q.assignedTo) and.push({ assignedTo: toObjectId(q.assignedTo) });
  if (q.followUp === 'due') and.push({ status: { $in: OPEN_LEAD_STATUSES }, nextFollowUpAt: { $lte: new Date() } });
  if (q.followUp === 'upcoming') and.push({ status: { $in: OPEN_LEAD_STATUSES }, nextFollowUpAt: { $gt: new Date() } });
  if (q.q) {
    const rx = new RegExp(escapeRegex(q.q), 'i');
    and.push({ $or: [{ name: rx }, { phone: rx }, { email: rx }] });
  }
  const filter = { $and: and, companyId: ctx.companyId };
  const sort = parseSort(q.sort, ['name', 'createdAt', 'nextFollowUpAt', 'status', 'lastActivityAt'], { createdAt: -1 });
  const [items, total] = await Promise.all([
    Lead.find(filter)
      .sort(sort)
      .skip((q.page - 1) * q.pageSize)
      .limit(q.pageSize)
      .populate('assignedTo', 'name')
      .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
      .lean(),
    Lead.countDocuments(filter),
  ]);
  return { items, meta: pageMeta(q.page, q.pageSize, total) };
}

export async function leadSummary(ctx: TenantContext, projectId?: string) {
  const match: Record<string, unknown> = { ...visibility(ctx) };
  if (projectId) {
    assertProjectAccess(ctx, projectId);
    match.projectId = toObjectId(projectId);
  }
  const [byStatus, due, bySource] = await Promise.all([
    Lead.aggregate<{ _id: string; n: number }>([{ $match: match }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    Lead.countDocuments({ ...match, status: { $in: OPEN_LEAD_STATUSES }, nextFollowUpAt: { $lte: new Date() } }),
    Lead.aggregate<{ _id: string; n: number; won: number }>([
      { $match: match },
      { $group: { _id: '$source', n: { $sum: 1 }, won: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, 1, 0] } } } },
    ]),
  ]);
  const counts = Object.fromEntries(byStatus.map((s) => [s._id, s.n]));
  const total = byStatus.reduce((a, s) => a + s.n, 0);
  const open = OPEN_LEAD_STATUSES.reduce((a, s) => a + (counts[s] ?? 0), 0);
  return { byStatus: counts, total, open, followUpsDue: due, conversionRateBp: total ? Math.round(((counts.won ?? 0) * 10_000) / total) : 0, bySource };
}

export async function getLead(ctx: TenantContext, id: string) {
  const lead = await Lead.findOne({ ...visibility(ctx), _id: toObjectId(id) })
    .populate('assignedTo', 'name email')
    .populate({ path: 'projectId', select: 'name code', match: { companyId: ctx.companyId } })
    .populate({ path: 'brokerId', select: 'name phone', match: { companyId: ctx.companyId } })
    .populate({ path: 'interestedPlotIds', select: 'plotNumber status blockId', match: { companyId: ctx.companyId } })
    .populate({ path: 'customerId', select: 'name customerCode', match: { companyId: ctx.companyId } })
    .lean();
  if (!lead) throw notFound('Lead');
  const activities = await LeadActivity.find({ companyId: ctx.companyId, leadId: lead._id }).sort({ createdAt: -1 }).limit(200).populate('actorId', 'name').lean();
  return { ...lead, activities };
}

export async function createLead(ctx: TenantContext, input: LeadInput) {
  await validateRefs(ctx, input);
  if (ctx.projectScope !== null && !input.projectId && !input.assignedTo) input.assignedTo = String(ctx.userId);
  const lead = await Lead.create({ companyId: ctx.companyId, ...normalize(input), status: 'new', createdBy: ctx.userId, lastActivityAt: new Date() });
  await logActivity(ctx, lead._id, 'note', 'Lead created');
  if (lead.assignedTo) await notifyAssignee(ctx, lead, lead.assignedTo);
  await audit(ctx, { action: 'crm.create', entityType: 'lead', entityId: lead._id, summary: lead.name });
  return lead.toJSON();
}

export async function updateLead(ctx: TenantContext, id: string, input: Partial<LeadInput>) {
  const lead = await loadLead(ctx, id);
  const { assignedTo: _ignored, ...rest } = input; // assignment has its own permission and endpoint
  await validateRefs(ctx, { ...rest, projectId: rest.projectId ?? (lead.projectId ? String(lead.projectId) : undefined) });
  lead.set(normalize(rest));
  await lead.save();
  await audit(ctx, { action: 'crm.update', entityType: 'lead', entityId: lead._id, changes: rest });
  return lead.toJSON();
}

export async function changeLeadStatus(ctx: TenantContext, id: string, status: LeadStatus, lostReason?: string) {
  const lead = await loadLead(ctx, id);
  if (status === 'won' && !lead.customerId) throw businessRule('Convert the lead to a customer to mark it won');
  if (lead.status === 'won' && status !== 'won') throw businessRule('Won leads cannot be reopened');
  const from = lead.status;
  lead.status = status;
  lead.lostReason = status === 'lost' ? lostReason : undefined;
  if (status === 'lost') lead.nextFollowUpAt = undefined;
  lead.lastActivityAt = new Date();
  await lead.save();
  await logActivity(ctx, lead._id, 'status_change', `Status changed from ${from} to ${status}${lostReason ? `: ${lostReason}` : ''}`);
  await audit(ctx, { action: 'crm.status_change', entityType: 'lead', entityId: lead._id, changes: { from, to: status, lostReason } });
  return lead.toJSON();
}

export async function addActivity(ctx: TenantContext, id: string, input: LeadActivityInput) {
  const lead = await loadLead(ctx, id);
  if (lead.status === 'won' || lead.status === 'lost') {
    if (input.nextFollowUpAt) throw businessRule('Closed leads cannot have follow-ups');
  }
  await logActivity(ctx, lead._id, input.type, input.summary, { outcome: input.outcome });
  lead.lastActivityAt = new Date();
  lead.nextFollowUpAt = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : undefined;
  if (lead.status === 'new' && input.type !== 'note') lead.status = 'contacted';
  if (input.type === 'site_visit' && (lead.status === 'new' || lead.status === 'contacted')) lead.status = 'site_visit';
  await lead.save();
  return lead.toJSON();
}

export async function assignLead(ctx: TenantContext, id: string, assignedTo: string | null) {
  const lead = await loadLead(ctx, id);
  if (assignedTo) await validateRefs(ctx, { assignedTo });
  lead.assignedTo = assignedTo ? toObjectId(assignedTo) : undefined;
  await lead.save();
  await logActivity(ctx, lead._id, 'note', assignedTo ? 'Lead reassigned' : 'Lead unassigned');
  if (lead.assignedTo) await notifyAssignee(ctx, lead, lead.assignedTo);
  await audit(ctx, { action: 'crm.assign', entityType: 'lead', entityId: lead._id, changes: { assignedTo } });
  return lead.toJSON();
}

/**
 * Converts a lead into a customer (or links an existing customer with the same phone) and
 * marks it won — atomically, so a lead can never produce two customers.
 */
export async function convertLead(ctx: TenantContext, id: string) {
  return withTransaction(async (session) => {
    const lead = await Lead.findOne({ ...visibility(ctx), _id: toObjectId(id) }).session(session);
    if (!lead) throw notFound('Lead');
    if (lead.customerId) throw businessRule('This lead has already been converted');
    if (lead.status === 'lost') throw businessRule('Reopen the lead before converting it');

    const existing = await Customer.findOne({ companyId: ctx.companyId, phone: lead.phone, deletedAt: null }).session(session).select('_id').lean();
    const linked = Boolean(existing);
    let customerId = existing?._id;
    if (!customerId) {
      const seq = await nextSequence(ctx.companyId, 'customer', session);
      const [created] = await Customer.create(
        [
          {
            companyId: ctx.companyId,
            customerCode: `C${String(seq).padStart(5, '0')}`,
            name: lead.name,
            phone: lead.phone,
            email: lead.email,
            leadId: lead._id,
            createdBy: ctx.userId,
          },
        ],
        { session },
      );
      customerId = created!._id;
    }
    const res = await Lead.updateOne(
      { companyId: ctx.companyId, _id: lead._id, customerId: null },
      { $set: { customerId: customerId, status: 'won', convertedAt: new Date(), lastActivityAt: new Date() }, $unset: { nextFollowUpAt: 1 } },
      { session },
    );
    if (res.modifiedCount !== 1) throw businessRule('This lead has already been converted');
    await LeadActivity.create(
      [{ companyId: ctx.companyId, leadId: lead._id, type: 'status_change', summary: linked ? 'Linked to existing customer and marked won' : 'Converted to customer', actorId: ctx.userId, completedAt: new Date() }],
      { session },
    );
    await audit(ctx, { action: 'crm.convert', entityType: 'lead', entityId: lead._id, changes: { customerId: String(customerId), linkedExisting: linked } }, session);
    return { leadId: String(lead._id), customerId: String(customerId), linkedExisting: linked };
  });
}

export async function deleteLead(ctx: TenantContext, id: string) {
  const lead = await loadLead(ctx, id);
  await Lead.updateOne({ companyId: ctx.companyId, _id: lead._id }, { $set: { deletedAt: new Date() } });
  await audit(ctx, { action: 'crm.delete', entityType: 'lead', entityId: lead._id, summary: lead.name });
}

/** Job: notify assignees of follow-ups due today (one notification per lead per day). */
export async function runFollowUpReminders(now = new Date()): Promise<number> {
  const endOfToday = new Date(now);
  endOfToday.setUTCHours(18, 29, 59, 999); // 23:59:59 IST
  if (endOfToday < now) endOfToday.setUTCDate(endOfToday.getUTCDate() + 1);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now);
  const leads = await Lead.find(
    { status: { $in: OPEN_LEAD_STATUSES }, deletedAt: null, assignedTo: { $ne: null }, nextFollowUpAt: { $lte: endOfToday } },
    null,
    { crossTenant: true },
  )
    .select('companyId assignedTo name phone nextFollowUpAt')
    .limit(5000)
    .lean();
  if (!leads.length) return 0;
  const res = await Notification.bulkWrite(
    leads.map((l) => ({
      updateOne: {
        filter: { userId: l.assignedTo!, dedupeKey: `followup:${l._id}:${day}` },
        update: {
          $setOnInsert: {
            companyId: l.companyId,
            userId: l.assignedTo!,
            type: 'lead_followup',
            title: `Follow up: ${l.name}`,
            body: `${l.phone}${l.nextFollowUpAt && l.nextFollowUpAt < now ? ' · overdue' : ' · due today'}`,
            link: `/crm?lead=${l._id}`,
            dedupeKey: `followup:${l._id}:${day}`,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
  return res.upsertedCount;
}
