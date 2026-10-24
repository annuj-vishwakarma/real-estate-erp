import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BellRing, CalendarClock, KanbanSquare, List, MessageSquarePlus, Phone, Plus, Target, Trash2, UserCheck } from 'lucide-react';
import { toast } from 'sonner';
import { LEAD_ACTIVITY_TYPES, LEAD_SOURCES, LEAD_STATUSES, OPEN_LEAD_STATUSES, type LeadStatus } from '@erp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatINRCompact, titleCase } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useListParams } from '@/hooks/use-list-params';
import { useProjectContext } from '@/hooks/use-project';
import { Can, useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Badge, Card, Input, Select, Skeleton, Tabs, TabsList, TabsTrigger, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Sheet, SheetContent } from '@/components/ui/overlays';
import { DataTable, type Column } from '@/components/data-table';
import { DescriptionList, Field, PageHeader, StatCard } from '@/components/common';
import { EmptyState, ErrorState } from '@/components/states';
import { SearchInput } from '@/components/search-input';
import { DocumentsPanel } from '@/components/documents-panel';
import { MoneyInput, paiseToInput, rupeeField, toPaise } from '@/components/money';

interface Lead {
  id: string;
  name: string;
  phone: string;
  email?: string;
  source: string;
  status: LeadStatus;
  budgetMinPaise?: number;
  budgetMaxPaise?: number;
  nextFollowUpAt?: string;
  lastActivityAt?: string;
  lostReason?: string;
  notes?: string;
  createdAt: string;
  assignedTo?: { id: string; name: string } | null;
  projectId?: { id: string; name: string; code: string } | null;
  brokerId?: { id: string; name: string } | null;
  customerId?: { id: string; name: string; customerCode: string } | null;
  interestedPlotIds?: { id: string; plotNumber: string; status: string }[];
  activities?: { id: string; type: string; summary: string; outcome?: string; createdAt: string; actorId?: { name: string } }[];
}

const STATUS_COLOR: Record<LeadStatus, string> = {
  new: 'bg-slate-400',
  contacted: 'bg-sky-500',
  site_visit: 'bg-violet-500',
  negotiation: 'bg-amber-500',
  won: 'bg-green-600',
  lost: 'bg-red-500',
};

function useMembers() {
  return useQuery({ queryKey: ['members'], queryFn: () => api.get<{ id: string; name: string }[]>('/members'), staleTime: 5 * 60_000 });
}

function followUpLabel(at?: string) {
  if (!at) return null;
  const d = new Date(at);
  const overdue = d.getTime() < Date.now();
  return { text: formatDateTime(at), overdue };
}

const leadForm = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\s-]{6,16}$/, 'Enter a valid phone number'),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional(),
  source: z.enum(LEAD_SOURCES),
  projectId: z.string().optional(),
  brokerId: z.string().optional(),
  assignedTo: z.string().optional(),
  budgetMin: rupeeField('Budget from', { required: false }),
  budgetMax: rupeeField('Budget to', { required: false }),
  nextFollowUpAt: z.string().optional(),
  notes: z.string().max(2000).optional(),
});
type LeadForm = z.infer<typeof leadForm>;

function LeadSheet({
  open,
  onOpenChange,
  lead,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  lead?: Lead;
  onCreated?: (id: string) => void;
}) {
  const qc = useQueryClient();
  const { projects, projectId } = useProjectContext();
  const { can, context } = useAuth();
  const members = useMembers();
  const brokers = useQuery({
    queryKey: ['brokers', 'options'],
    queryFn: () => api.get<{ id: string; name: string }[]>('/brokers'),
    enabled: can('brokers.read'),
  });
  const form = useForm<LeadForm>({
    resolver: zodResolver(leadForm),
    values: {
      name: lead?.name ?? '',
      phone: lead?.phone ?? '',
      email: lead?.email ?? '',
      source: (lead?.source as LeadForm['source']) ?? 'walk_in',
      projectId: lead?.projectId?.id ?? projectId ?? '',
      brokerId: lead?.brokerId?.id ?? '',
      assignedTo: lead?.assignedTo?.id ?? context?.user.id ?? '',
      budgetMin: paiseToInput(lead?.budgetMinPaise),
      budgetMax: paiseToInput(lead?.budgetMaxPaise),
      nextFollowUpAt: lead?.nextFollowUpAt ? lead.nextFollowUpAt.slice(0, 16) : '',
      notes: lead?.notes ?? '',
    },
  });
  const save = useMutation({
    mutationFn: (v: LeadForm) => {
      const payload = {
        name: v.name,
        phone: v.phone,
        email: v.email || undefined,
        source: v.source,
        projectId: v.projectId || undefined,
        brokerId: v.brokerId || undefined,
        budgetMinPaise: v.budgetMin ? toPaise(v.budgetMin) : undefined,
        budgetMaxPaise: v.budgetMax ? toPaise(v.budgetMax) : undefined,
        nextFollowUpAt: v.nextFollowUpAt ? new Date(v.nextFollowUpAt).toISOString() : undefined,
        notes: v.notes || undefined,
        ...(lead ? {} : { assignedTo: v.assignedTo || undefined }),
      };
      return lead ? api.patch<Lead>(`/leads/${lead.id}`, payload) : api.post<Lead>('/leads', payload);
    },
    onSuccess: (l) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      toast.success(lead ? 'Lead updated' : 'Lead added');
      onOpenChange(false);
      if (!lead) onCreated?.(l.id);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const e = form.formState.errors;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={lead ? `Edit ${lead.name}` : 'New lead'}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="lead-form" loading={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form id="lead-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <Field label="Name" htmlFor="ld-name" error={e.name?.message} required className="sm:col-span-2">
            <Input {...form.register('name')} />
          </Field>
          <Field label="Phone" htmlFor="ld-phone" error={e.phone?.message} required>
            <Input type="tel" {...form.register('phone')} />
          </Field>
          <Field label="Email" htmlFor="ld-email" error={e.email?.message}>
            <Input type="email" {...form.register('email')} />
          </Field>
          <Field label="Source" htmlFor="ld-source">
            <Select {...form.register('source')}>
              {LEAD_SOURCES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Interested in project" htmlFor="ld-project">
            <Select {...form.register('projectId')}>
              <option value="">Not decided</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {can('brokers.read') && (
            <Field label="Broker" htmlFor="ld-broker">
              <Select {...form.register('brokerId')}>
                <option value="">Direct</option>
                {brokers.data?.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {!lead && (
            <Field label="Owner" htmlFor="ld-owner" hint={can('crm.assign') ? undefined : 'Only you, unless you can assign leads'}>
              <Select {...form.register('assignedTo')} disabled={!can('crm.assign')}>
                <option value="">Unassigned</option>
                {members.data?.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Budget from" htmlFor="ld-bmin" error={e.budgetMin?.message}>
            <MoneyInput {...form.register('budgetMin')} />
          </Field>
          <Field label="Budget to" htmlFor="ld-bmax" error={e.budgetMax?.message}>
            <MoneyInput {...form.register('budgetMax')} />
          </Field>
          <Field label="Next follow-up" htmlFor="ld-fu">
            <Input type="datetime-local" {...form.register('nextFollowUpAt')} />
          </Field>
          <Field label="Notes" htmlFor="ld-notes" className="sm:col-span-2">
            <Textarea rows={3} {...form.register('notes')} />
          </Field>
        </form>
      </SheetContent>
    </Sheet>
  );
}

const activityForm = z.object({
  type: z.enum(LEAD_ACTIVITY_TYPES),
  summary: z.string().trim().min(1, 'Describe the interaction').max(1000),
  outcome: z.string().max(300).optional(),
  nextFollowUpAt: z.string().optional(),
});

function LeadDrawer({ leadId, onClose }: { leadId: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const members = useMembers();
  const [editing, setEditing] = React.useState(false);
  const [losing, setLosing] = React.useState(false);
  const [lostReason, setLostReason] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  const q = useQuery({ queryKey: ['leads', 'detail', leadId], queryFn: () => api.get<Lead>(`/leads/${leadId}`), enabled: Boolean(leadId) });
  const form = useForm<z.infer<typeof activityForm>>({
    resolver: zodResolver(activityForm),
    defaultValues: { type: 'call', summary: '', outcome: '', nextFollowUpAt: '' },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['leads'] });
  const onErr = (e: unknown) => toast.error(errorMessage(e));

  const logActivity = useMutation({
    mutationFn: (v: z.infer<typeof activityForm>) =>
      api.post(`/leads/${leadId}/activities`, {
        type: v.type,
        summary: v.summary,
        outcome: v.outcome || undefined,
        nextFollowUpAt: v.nextFollowUpAt ? new Date(v.nextFollowUpAt).toISOString() : undefined,
      }),
    onSuccess: () => {
      refresh();
      form.reset({ type: 'call', summary: '', outcome: '', nextFollowUpAt: '' });
      toast.success('Activity logged');
    },
    onError: onErr,
  });
  const setStatus = useMutation({
    mutationFn: (v: { status: LeadStatus; lostReason?: string }) => api.post(`/leads/${leadId}/status`, v),
    onSuccess: () => {
      refresh();
      setLosing(false);
      setLostReason('');
    },
    onError: onErr,
  });
  const assign = useMutation({
    mutationFn: (assignedTo: string | null) => api.post(`/leads/${leadId}/assign`, { assignedTo }),
    onSuccess: refresh,
    onError: onErr,
  });
  const convert = useMutation({
    mutationFn: () => api.post<{ customerId: string; linkedExisting: boolean }>(`/leads/${leadId}/convert`),
    onSuccess: (r) => {
      refresh();
      toast.success(r.linkedExisting ? 'Linked to the existing customer with this phone' : 'Customer created');
    },
    onError: onErr,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/leads/${leadId}`),
    onSuccess: () => {
      refresh();
      setDeleting(false);
      onClose();
    },
    onError: onErr,
  });

  const l = q.data;
  const closed = l?.status === 'won' || l?.status === 'lost';
  const fu = followUpLabel(l?.nextFollowUpAt);
  return (
    <>
      <Sheet open={Boolean(leadId)} onOpenChange={(o) => !o && onClose()}>
        <SheetContent
          title={l?.name ?? 'Lead'}
          description={l ? `${l.phone}${l.email ? ` · ${l.email}` : ''} · ${titleCase(l.source)}` : undefined}
          className="sm:max-w-2xl"
          footer={
            l && (
              <div className="flex w-full flex-wrap justify-between gap-2">
                <div className="flex gap-2">
                  <Can permission="crm.delete">
                    <Button variant="ghost" size="icon" onClick={() => setDeleting(true)} aria-label="Delete lead">
                      <Trash2 />
                    </Button>
                  </Can>
                  <Can permission="crm.update">
                    <Button variant="outline" onClick={() => setEditing(true)}>
                      Edit
                    </Button>
                  </Can>
                </div>
                {l.customerId ? (
                  <div className="flex gap-2">
                    <Button variant="outline" asChild>
                      <Link to={`/customers/${l.customerId.id}`}>Open customer</Link>
                    </Button>
                    {can('bookings.create') && (
                      <Button
                        onClick={() =>
                          navigate(`/bookings/new?customer=${l.customerId!.id}${l.projectId ? `&project=${l.projectId.id}` : ''}`)
                        }
                      >
                        New booking
                      </Button>
                    )}
                  </div>
                ) : (
                  can('crm.update') &&
                  can('customers.create') &&
                  l.status !== 'lost' && (
                    <Button loading={convert.isPending} onClick={() => convert.mutate()}>
                      <UserCheck /> Convert to customer
                    </Button>
                  )
                )}
              </div>
            )
          }
        >
          {q.isPending ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-40" />
            </div>
          ) : q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : l ? (
            <div className="space-y-6">
              {/* Pipeline stepper */}
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Lead status">
                {OPEN_LEAD_STATUSES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!can('crm.update') || closed || setStatus.isPending}
                    onClick={() => setStatus.mutate({ status: s })}
                    aria-pressed={l.status === s}
                    className={cn(
                      'rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:cursor-default cursor-pointer',
                      l.status === s ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-muted',
                    )}
                  >
                    {titleCase(s)}
                  </button>
                ))}
                {l.status === 'won' && <Badge variant="success">Won</Badge>}
                {l.status === 'lost' ? (
                  <>
                    <Badge variant="destructive">Lost{l.lostReason ? `: ${l.lostReason}` : ''}</Badge>
                    {can('crm.update') && (
                      <Button size="sm" variant="link" className="h-auto p-0" onClick={() => setStatus.mutate({ status: 'contacted' })}>
                        Reopen
                      </Button>
                    )}
                  </>
                ) : (
                  !closed &&
                  can('crm.update') && (
                    <button
                      type="button"
                      onClick={() => setLosing(true)}
                      className="rounded-full border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 cursor-pointer"
                    >
                      Mark lost
                    </button>
                  )
                )}
              </div>

              <DescriptionList
                items={[
                  { label: 'Project', value: l.projectId?.name ?? '—' },
                  {
                    label: 'Owner',
                    value: can('crm.assign') ? (
                      <Select
                        className="h-8"
                        value={l.assignedTo?.id ?? ''}
                        onChange={(e) => assign.mutate(e.target.value || null)}
                        aria-label="Assign lead"
                      >
                        <option value="">Unassigned</option>
                        {members.data?.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.name}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      (l.assignedTo?.name ?? 'Unassigned')
                    ),
                  },
                  {
                    label: 'Budget',
                    value:
                      l.budgetMinPaise || l.budgetMaxPaise
                        ? `${l.budgetMinPaise ? formatINRCompact(l.budgetMinPaise) : '…'} – ${l.budgetMaxPaise ? formatINRCompact(l.budgetMaxPaise) : '…'}`
                        : '—',
                  },
                  { label: 'Broker', value: l.brokerId?.name ?? 'Direct' },
                  {
                    label: 'Next follow-up',
                    value: fu ? (
                      <span className={fu.overdue ? 'font-medium text-destructive' : ''}>
                        {fu.text}
                        {fu.overdue ? ' (overdue)' : ''}
                      </span>
                    ) : (
                      '—'
                    ),
                  },
                  { label: 'Plots of interest', value: l.interestedPlotIds?.map((p) => p.plotNumber).join(', ') || '—' },
                ]}
              />
              {l.notes && <p className="whitespace-pre-line text-sm text-muted-foreground">{l.notes}</p>}

              {can('crm.update') && !closed && (
                <form className="space-y-3 rounded-lg border p-4" onSubmit={form.handleSubmit((v) => logActivity.mutate(v))} noValidate>
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <MessageSquarePlus className="size-4" /> Log an interaction
                  </p>
                  <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                    <Select aria-label="Activity type" {...form.register('type')}>
                      {LEAD_ACTIVITY_TYPES.filter((t) => t !== 'status_change').map((t) => (
                        <option key={t} value={t}>
                          {titleCase(t)}
                        </option>
                      ))}
                    </Select>
                    <Input
                      placeholder="What happened?"
                      aria-label="Summary"
                      {...form.register('summary')}
                      aria-invalid={form.formState.errors.summary ? true : undefined}
                    />
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Input placeholder="Outcome (optional)" aria-label="Outcome" {...form.register('outcome')} />
                    <Input type="datetime-local" aria-label="Next follow-up" {...form.register('nextFollowUpAt')} />
                  </div>
                  <Button type="submit" size="sm" loading={logActivity.isPending}>
                    Save activity
                  </Button>
                </form>
              )}

              <div>
                <p className="mb-2 text-sm font-medium">Timeline</p>
                <ol className="relative space-y-3 border-l pl-4">
                  {l.activities?.map((a) => (
                    <li key={a.id} className="relative text-sm">
                      <span className="absolute -left-[22.5px] top-1 size-3 rounded-full border-2 border-card bg-primary" aria-hidden />
                      <p>
                        <span className="font-medium">{titleCase(a.type)}</span> · {a.summary}
                      </p>
                      {a.outcome && <p className="text-muted-foreground">{a.outcome}</p>}
                      <p className="text-xs text-muted-foreground">
                        {a.actorId?.name} · {formatDateTime(a.createdAt)}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
              <DocumentsPanel entityType="lead" entityId={l.id} compact />
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
      {l && <LeadSheet open={editing} onOpenChange={setEditing} lead={l} />}
      <ConfirmDialog
        open={losing}
        onOpenChange={setLosing}
        title="Mark this lead lost?"
        destructive
        confirmLabel="Mark lost"
        loading={setStatus.isPending}
        onConfirm={() => (lostReason.trim() ? setStatus.mutate({ status: 'lost', lostReason }) : toast.error('Give a reason'))}
      >
        <Field label="Reason" htmlFor="lost-reason" required>
          <Input value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="e.g. Bought elsewhere, budget mismatch" />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this lead?"
        destructive
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}

function LeadCard({ lead, onOpen }: { lead: Lead; onOpen: () => void }) {
  const fu = followUpLabel(lead.nextFollowUpAt);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-lg border bg-card p-3 text-left shadow-xs transition-shadow hover:shadow-md cursor-pointer"
    >
      <p className="truncate text-sm font-medium">{lead.name}</p>
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Phone className="size-3" /> {lead.phone}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {lead.projectId && <Badge variant="secondary">{lead.projectId.code}</Badge>}
        <Badge variant="outline">{titleCase(lead.source)}</Badge>
      </div>
      {fu && (
        <p className={cn('mt-2 flex items-center gap-1 text-xs', fu.overdue ? 'font-medium text-destructive' : 'text-muted-foreground')}>
          <CalendarClock className="size-3" /> {fu.text}
        </p>
      )}
      {lead.assignedTo && <p className="mt-1 text-xs text-muted-foreground">{lead.assignedTo.name}</p>}
    </button>
  );
}

export function CrmPage() {
  const lp = useListParams({ pageSize: 50 });
  const [params, setParams] = useSearchParams();
  const { projectId } = useProjectContext();
  const view = params.get('view') ?? 'board';
  const openLead = params.get('lead');
  const [creating, setCreating] = React.useState(false);
  const filters = {
    status: lp.filter('status'),
    source: lp.filter('source'),
    assignedTo: lp.filter('assignedTo'),
    followUp: lp.filter('followUp'),
  };
  const setParam = (k: string, v: string | null) =>
    setParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (v) n.set(k, v);
        else n.delete(k);
        return n;
      },
      { replace: true },
    );

  const summary = useQuery({
    queryKey: ['leads', 'summary', projectId],
    queryFn: () =>
      api.get<{ open: number; followUpsDue: number; total: number; conversionRateBp: number; byStatus: Record<string, number> }>(
        '/leads/summary',
        { projectId: projectId ?? undefined },
      ),
  });
  const board = useQuery({
    queryKey: ['leads', 'board', projectId, lp.q, filters.source, filters.assignedTo],
    queryFn: () =>
      api.page<Lead>('/leads', {
        pageSize: 100,
        sort: 'nextFollowUpAt',
        q: lp.q || undefined,
        source: filters.source,
        assignedTo: filters.assignedTo,
        projectId: projectId ?? undefined,
      }),
    enabled: view === 'board',
  });
  const list = useQuery({
    queryKey: ['leads', 'list', projectId, lp.query, filters],
    queryFn: () => api.page<Lead>('/leads', { ...lp.query, ...filters, projectId: projectId ?? undefined }),
    enabled: view === 'list',
    placeholderData: (p) => p,
  });
  const columns: Column<Lead>[] = [
    { key: 'name', header: 'Name', sortKey: 'name', cell: (l) => <span className="font-medium">{l.name}</span> },
    { key: 'phone', header: 'Phone', cell: (l) => l.phone },
    { key: 'project', header: 'Project', cell: (l) => l.projectId?.code ?? '—', hideOnMobile: true },
    { key: 'source', header: 'Source', cell: (l) => titleCase(l.source), hideOnMobile: true },
    { key: 'owner', header: 'Owner', cell: (l) => l.assignedTo?.name ?? '—', hideOnMobile: true },
    {
      key: 'fu',
      header: 'Follow-up',
      sortKey: 'nextFollowUpAt',
      cell: (l) => {
        const fu = followUpLabel(l.nextFollowUpAt);
        return fu ? <span className={fu.overdue ? 'text-destructive' : ''}>{fu.text}</span> : '—';
      },
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      cell: (l) => (
        <span className="inline-flex items-center gap-1.5 text-sm">
          <span className={cn('size-2 rounded-full', STATUS_COLOR[l.status])} aria-hidden />
          {titleCase(l.status)}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Leads"
        description="Enquiries, follow-ups and conversions"
        actions={
          <Can permission="crm.create">
            <Button onClick={() => setCreating(true)}>
              <Plus /> New lead
            </Button>
          </Can>
        }
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open leads" value={summary.data?.open ?? '—'} loading={summary.isPending} icon={Target} />
        <StatCard
          label="Follow-ups due"
          value={summary.data?.followUpsDue ?? '—'}
          loading={summary.isPending}
          icon={BellRing}
          tone={summary.data?.followUpsDue ? 'danger' : 'default'}
        />
        <StatCard label="Won" value={summary.data?.byStatus.won ?? 0} loading={summary.isPending} tone="success" />
        <StatCard
          label="Conversion rate"
          value={summary.data ? `${(summary.data.conversionRateBp / 100).toFixed(1)}%` : '—'}
          loading={summary.isPending}
          hint={summary.data ? `${summary.data.total} leads in total` : undefined}
        />
      </div>
      <div className="mb-4 flex flex-col gap-2 lg:flex-row lg:items-center">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Name, phone or email" />
        <Select
          className="lg:w-40"
          value={filters.source ?? ''}
          onChange={(e) => lp.setFilter('source', e.target.value || undefined)}
          aria-label="Source"
        >
          <option value="">All sources</option>
          {LEAD_SOURCES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
        <Select
          className="lg:w-40"
          value={filters.assignedTo ?? ''}
          onChange={(e) => lp.setFilter('assignedTo', e.target.value || undefined)}
          aria-label="Owner"
        >
          <option value="">Everyone</option>
          <option value="me">My leads</option>
          <option value="unassigned">Unassigned</option>
        </Select>
        {view === 'list' && (
          <>
            <Select
              className="lg:w-40"
              value={filters.status ?? ''}
              onChange={(e) => lp.setFilter('status', e.target.value || undefined)}
              aria-label="Status"
            >
              <option value="">All statuses</option>
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
            <Select
              className="lg:w-44"
              value={filters.followUp ?? ''}
              onChange={(e) => lp.setFilter('followUp', e.target.value || undefined)}
              aria-label="Follow-up"
            >
              <option value="">Any follow-up</option>
              <option value="due">Due now</option>
              <option value="upcoming">Upcoming</option>
            </Select>
          </>
        )}
        <Tabs value={view} onValueChange={(v) => setParam('view', v)} className="lg:ml-auto">
          <TabsList>
            <TabsTrigger value="board">
              <KanbanSquare className="size-4" /> Board
            </TabsTrigger>
            <TabsTrigger value="list">
              <List className="size-4" /> List
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {view === 'board' ? (
        board.isError ? (
          <ErrorState error={board.error} onRetry={() => board.refetch()} />
        ) : (
          <div className="grid gap-3 overflow-x-auto pb-2 md:grid-cols-2 xl:grid-cols-4">
            {OPEN_LEAD_STATUSES.map((s) => {
              const items = board.data?.items.filter((l) => l.status === s) ?? [];
              return (
                <Card key={s} className="flex min-h-64 flex-col bg-muted/40 p-3">
                  <div className="mb-3 flex items-center justify-between">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <span className={cn('size-2 rounded-full', STATUS_COLOR[s])} aria-hidden />
                      {titleCase(s)}
                    </p>
                    <span className="text-xs text-muted-foreground">{summary.data?.byStatus[s] ?? items.length}</span>
                  </div>
                  <div className="flex-1 space-y-2">
                    {board.isPending ? (
                      <Skeleton className="h-20" />
                    ) : items.length === 0 ? (
                      <p className="py-6 text-center text-xs text-muted-foreground">No leads</p>
                    ) : (
                      items.map((l) => <LeadCard key={l.id} lead={l} onOpen={() => setParam('lead', l.id)} />)
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )
      ) : (
        <DataTable
          columns={columns}
          rows={list.data?.items}
          rowKey={(l) => l.id}
          loading={list.isPending}
          error={list.error}
          onRetry={() => list.refetch()}
          meta={list.data?.meta}
          onPageChange={lp.setPage}
          pageSize={lp.pageSize}
          onPageSizeChange={lp.setPageSize}
          sort={lp.sort}
          onSortChange={lp.setSort}
          onRowClick={(l) => setParam('lead', l.id)}
          empty={<EmptyState icon={Target} title="No leads match" />}
        />
      )}

      <LeadDrawer leadId={openLead} onClose={() => setParam('lead', null)} />
      <LeadSheet open={creating} onOpenChange={setCreating} onCreated={(id) => setParam('lead', id)} />
    </>
  );
}
