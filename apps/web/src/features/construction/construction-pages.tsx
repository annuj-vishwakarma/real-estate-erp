import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, CheckCircle2, Circle, HardHat, IndianRupee, Pencil, Plus, Receipt, Trash2, Truck, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  PAYMENT_MODES,
  todayInIndia,
  VENDOR_CATEGORIES,
  WORK_ORDER_STATUSES,
  WORK_ORDER_TRANSITIONS,
  type WorkOrderStatus,
} from '@erp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatINR, formatINRCompact, titleCase } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/utils';
import { useListParams } from '@/hooks/use-list-params';
import { useProjectContext } from '@/hooks/use-project';
import { Can, useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog, Dialog, DialogContent, DialogFooter, Sheet, SheetContent } from '@/components/ui/overlays';
import { DataTable, type Column } from '@/components/data-table';
import { DescriptionList, Field, PageHeader, StatCard, StatusBadge } from '@/components/common';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { SearchInput } from '@/components/search-input';
import { DocumentsPanel } from '@/components/documents-panel';
import { MoneyInput, paiseToInput, percentField, rupeeField, toBp, toPaise } from '@/components/money';

interface Vendor {
  id: string;
  name: string;
  category: string;
  phone?: string;
  email?: string;
  gstin?: string;
  pan?: string;
  address?: { line1?: string; city?: string; state?: string };
  isActive: boolean;
  payablePaise?: number;
  payableBalancePaise?: number;
  workOrders?: WorkOrder[];
  ledger?: {
    id: string;
    entryNumber: string;
    date: string;
    narration: string;
    debitPaise: number;
    creditPaise: number;
    balancePaise: number;
  }[];
}
interface WorkOrder {
  id: string;
  number: string;
  title: string;
  scope?: string;
  amountPaise: number;
  billedPaise: number;
  remainingPaise?: number;
  status: WorkOrderStatus;
  startDate?: string;
  endDate?: string;
  milestones: { id: string; name: string; percentBp?: number; dueDate?: string; completedAt?: string }[];
  vendorId?: { id: string; name: string; category?: string; phone?: string; gstin?: string };
  projectId?: { id: string; name: string; code: string };
  bills?: Expense[];
}
interface Expense {
  id: string;
  number: string;
  date: string;
  amountPaise: number;
  description: string;
  billNumber?: string;
  settlement: 'paid' | 'payable';
  status: 'posted' | 'reversed';
  vendorId?: { id: string; name: string };
  projectId?: { id: string; name: string; code: string };
  expenseAccountId?: { code: string; name: string };
  workOrderId?: { id: string; number: string };
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  systemKey?: string;
  isActive: boolean;
}

const WO_VARIANT: Record<WorkOrderStatus, string> = {
  draft: 'pending',
  issued: 'planning',
  in_progress: 'partial',
  completed: 'completed',
  cancelled: 'cancelled',
};

function useVendorOptions() {
  return useQuery({
    queryKey: ['vendors', 'options'],
    queryFn: () => api.page<Vendor>('/vendors', { pageSize: 100 }),
    select: (r) => r.items,
  });
}

// ---------------- Vendors ----------------

const vendorForm = z.object({
  name: z.string().trim().min(1, 'Vendor name is required').max(150),
  category: z.enum(VENDOR_CATEGORIES),
  phone: z
    .string()
    .trim()
    .regex(/^(\+?[0-9][0-9\s-]{6,16})?$/, 'Enter a valid phone number')
    .optional(),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional(),
  gstin: z
    .string()
    .trim()
    .regex(/^([0-9]{2}[A-Za-z0-9]{10}[0-9A-Za-z][Zz][0-9A-Za-z])?$/, 'Enter a valid GSTIN')
    .optional(),
  pan: z
    .string()
    .trim()
    .regex(/^([A-Za-z]{5}[0-9]{4}[A-Za-z])?$/, 'Enter a valid PAN')
    .optional(),
  line1: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  isActive: z.boolean(),
});

function VendorSheet({ open, onOpenChange, vendor }: { open: boolean; onOpenChange: (o: boolean) => void; vendor?: Vendor }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = useForm<z.infer<typeof vendorForm>>({
    resolver: zodResolver(vendorForm),
    values: {
      name: vendor?.name ?? '',
      category: (vendor?.category as (typeof VENDOR_CATEGORIES)[number]) ?? 'civil',
      phone: vendor?.phone ?? '',
      email: vendor?.email ?? '',
      gstin: vendor?.gstin ?? '',
      pan: vendor?.pan ?? '',
      line1: vendor?.address?.line1 ?? '',
      city: vendor?.address?.city ?? '',
      isActive: vendor?.isActive ?? true,
    },
  });
  const save = useMutation({
    mutationFn: (v: z.infer<typeof vendorForm>) => {
      const payload = {
        name: v.name,
        category: v.category,
        phone: v.phone || undefined,
        email: v.email || undefined,
        gstin: v.gstin ? v.gstin.toUpperCase() : undefined,
        pan: v.pan ? v.pan.toUpperCase() : undefined,
        address: { line1: v.line1 || undefined, city: v.city || undefined },
        isActive: v.isActive,
      };
      return vendor ? api.patch<Vendor>(`/vendors/${vendor.id}`, payload) : api.post<Vendor>('/vendors', payload);
    },
    onSuccess: (v) => {
      qc.invalidateQueries({ queryKey: ['vendors'] });
      toast.success('Vendor saved');
      onOpenChange(false);
      if (!vendor) navigate(`/vendors/${v.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const e = form.formState.errors;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={vendor ? `Edit ${vendor.name}` : 'New vendor'}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="vendor-form" loading={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form id="vendor-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <Field label="Name" htmlFor="vn-name" error={e.name?.message} required className="sm:col-span-2">
            <Input {...form.register('name')} />
          </Field>
          <Field label="Category" htmlFor="vn-cat">
            <Select {...form.register('category')}>
              {VENDOR_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {titleCase(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Phone" htmlFor="vn-phone" error={e.phone?.message}>
            <Input type="tel" {...form.register('phone')} />
          </Field>
          <Field label="Email" htmlFor="vn-email" error={e.email?.message}>
            <Input type="email" {...form.register('email')} />
          </Field>
          <Field label="GSTIN" htmlFor="vn-gst" error={e.gstin?.message}>
            <Input className="uppercase" {...form.register('gstin')} />
          </Field>
          <Field label="PAN" htmlFor="vn-pan" error={e.pan?.message}>
            <Input className="uppercase" {...form.register('pan')} />
          </Field>
          <Field label="City" htmlFor="vn-city">
            <Input {...form.register('city')} />
          </Field>
          <Field label="Address" htmlFor="vn-line1" className="sm:col-span-2">
            <Input {...form.register('line1')} />
          </Field>
          <div className="flex items-center gap-2">
            <Checkbox id="vn-active" checked={form.watch('isActive')} onCheckedChange={(c) => form.setValue('isActive', c === true)} />
            <Label htmlFor="vn-active">Active</Label>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function VendorsPage() {
  const lp = useListParams();
  const navigate = useNavigate();
  const [creating, setCreating] = React.useState(false);
  const category = lp.filter('category');
  const q = useQuery({
    queryKey: ['vendors', lp.query, category],
    queryFn: () => api.page<Vendor>('/vendors', { ...lp.query, category, includeInactive: true }),
    placeholderData: (p) => p,
  });
  const columns: Column<Vendor>[] = [
    { key: 'name', header: 'Vendor', sortKey: 'name', cell: (v) => <span className="font-medium">{v.name}</span> },
    { key: 'cat', header: 'Category', sortKey: 'category', cell: (v) => titleCase(v.category) },
    { key: 'phone', header: 'Phone', cell: (v) => v.phone ?? '—', hideOnMobile: true },
    { key: 'gst', header: 'GSTIN', cell: (v) => v.gstin ?? '—', hideOnMobile: true },
    { key: 'payable', header: 'Payable', align: 'right', cell: (v) => formatINR(v.payablePaise ?? 0, { decimals: false }) },
    { key: 'status', header: '', cell: (v) => (v.isActive ? null : <StatusBadge status="disabled" />) },
  ];
  return (
    <>
      <PageHeader
        title="Vendors"
        description="Contractors and suppliers, with what you owe each"
        actions={
          <Can permission="vendors.create">
            <Button onClick={() => setCreating(true)}>
              <Plus /> New vendor
            </Button>
          </Can>
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Name, phone or GSTIN" />
        <Select
          className="sm:w-44"
          value={category ?? ''}
          onChange={(e) => lp.setFilter('category', e.target.value || undefined)}
          aria-label="Category"
        >
          <option value="">All categories</option>
          {VENDOR_CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {titleCase(c)}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={q.data?.items}
        rowKey={(v) => v.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => q.refetch()}
        meta={q.data?.meta}
        onPageChange={lp.setPage}
        sort={lp.sort}
        onSortChange={lp.setSort}
        onRowClick={(v) => navigate(`/vendors/${v.id}`)}
        empty={<EmptyState icon={Truck} title="No vendors yet" />}
      />
      <VendorSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

const vendorPayForm = z.object({
  amount: rupeeField('Amount', { min: 1 }),
  paidOn: z.string().min(10),
  mode: z.enum(PAYMENT_MODES),
  reference: z.string().max(100).optional(),
});

export function VendorDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [paying, setPaying] = React.useState(false);
  const keyRef = React.useRef(newIdempotencyKey());
  const q = useQuery({ queryKey: ['vendors', 'detail', id], queryFn: () => api.get<Vendor>(`/vendors/${id}`) });
  const form = useForm<z.infer<typeof vendorPayForm>>({
    resolver: zodResolver(vendorPayForm),
    defaultValues: { amount: '', paidOn: todayInIndia(), mode: 'neft', reference: '' },
  });
  const pay = useMutation({
    mutationFn: (v: z.infer<typeof vendorPayForm>) =>
      api.post<{ number: string }>(
        `/vendors/${id}/payments`,
        { amountPaise: toPaise(v.amount), paidOn: v.paidOn, mode: v.mode, reference: v.reference || undefined },
        keyRef.current,
      ),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['vendors'] });
      setPaying(false);
      form.reset({ amount: '', paidOn: todayInIndia(), mode: 'neft' });
      toast.success(`Payment ${p.number} recorded`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = q.data;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Vendors', to: '/vendors' }, { label: v.name }]}
        title={v.name}
        description={`${titleCase(v.category)}${v.gstin ? ` · GSTIN ${v.gstin}` : ''}${v.phone ? ` · ${v.phone}` : ''}`}
        actions={
          <>
            <Can permission="vendors.update">
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </Can>
            {can('vendors.pay') && (
              <Button
                disabled={!v.payableBalancePaise}
                onClick={() => {
                  keyRef.current = newIdempotencyKey();
                  form.setValue('amount', paiseToInput(v.payableBalancePaise));
                  setPaying(true);
                }}
              >
                <IndianRupee /> Pay vendor
              </Button>
            )}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Payable"
          value={formatINR(v.payableBalancePaise ?? 0, { decimals: false })}
          tone={v.payableBalancePaise ? 'warning' : 'default'}
        />
        <StatCard label="Work orders" value={v.workOrders?.length ?? 0} icon={HardHat} />
        <StatCard
          label="Committed"
          value={formatINRCompact(v.workOrders?.filter((w) => w.status !== 'cancelled').reduce((s, w) => s + w.amountPaise, 0) ?? 0)}
        />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Statement</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {!v.ledger?.length ? (
              <EmptyState title="No bills or payments yet" />
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-2">Date</th>
                    <th className="py-2 pr-2">Particulars</th>
                    <th className="py-2 pr-2 text-right">Billed</th>
                    <th className="py-2 pr-2 text-right">Paid</th>
                    <th className="py-2 text-right">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {v.ledger.map((r, i) => (
                    <tr key={`${r.id}-${i}`} className="border-b last:border-0">
                      <td className="py-2 pr-2 whitespace-nowrap">{formatDate(r.date.slice(0, 10))}</td>
                      <td className="py-2 pr-2">
                        <Link to={`/accounting/entries/${r.id}`} className="text-primary hover:underline">
                          {r.entryNumber}
                        </Link>
                        <span className="block text-xs text-muted-foreground">{r.narration}</span>
                      </td>
                      <td className="py-2 pr-2 text-right tabular">{r.creditPaise ? formatINR(r.creditPaise) : ''}</td>
                      <td className="py-2 pr-2 text-right tabular">{r.debitPaise ? formatINR(r.debitPaise) : ''}</td>
                      <td className="py-2 text-right tabular">{formatINR(r.balancePaise)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Work orders</CardTitle>
            </CardHeader>
            <CardContent>
              {!v.workOrders?.length ? (
                <EmptyState title="No work orders" />
              ) : (
                <ul className="divide-y">
                  {v.workOrders.map((w) => (
                    <li key={w.id}>
                      <Link to={`/work-orders/${w.id}`} className="flex items-center justify-between gap-2 py-2.5 hover:bg-muted/40">
                        <span>
                          <span className="font-medium">{w.number}</span> · {w.title}
                          <span className="block text-xs text-muted-foreground">{w.projectId?.name}</span>
                        </span>
                        <span className="flex items-center gap-2 text-sm">
                          <span className="tabular">
                            {formatINRCompact(w.billedPaise)} / {formatINRCompact(w.amountPaise)}
                          </span>
                          <StatusBadge status={WO_VARIANT[w.status]} label={titleCase(w.status)} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <DescriptionList
                items={[
                  { label: 'Email', value: v.email },
                  { label: 'PAN', value: v.pan },
                  { label: 'Address', value: [v.address?.line1, v.address?.city].filter(Boolean).join(', ') || undefined },
                ]}
              />
            </CardContent>
          </Card>
          <DocumentsPanel entityType="vendor" entityId={v.id} compact />
        </div>
      </div>
      <VendorSheet open={editing} onOpenChange={setEditing} vendor={v} />
      <Dialog open={paying} onOpenChange={setPaying}>
        <DialogContent title={`Pay ${v.name}`} description={`Payable ${formatINR(v.payableBalancePaise ?? 0)}`}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((x) => pay.mutate(x))} noValidate>
            <Field label="Amount" htmlFor="vp-amount" error={form.formState.errors.amount?.message} required>
              <MoneyInput {...form.register('amount')} />
            </Field>
            <Field label="Paid on" htmlFor="vp-date">
              <Input type="date" {...form.register('paidOn')} />
            </Field>
            <Field label="Mode" htmlFor="vp-mode">
              <Select {...form.register('mode')}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {titleCase(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" htmlFor="vp-ref">
              <Input {...form.register('reference')} />
            </Field>
            <DialogFooter className="sm:col-span-2">
              <Button type="submit" loading={pay.isPending}>
                Record payment
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------- Work orders ----------------

const woForm = z.object({
  projectId: z.string().min(1, 'Choose a project'),
  vendorId: z.string().min(1, 'Choose a vendor'),
  title: z.string().trim().min(1, 'Title is required').max(200),
  scope: z.string().max(4000).optional(),
  amount: rupeeField('Amount', { min: 1 }),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  milestones: z
    .array(
      z.object({ name: z.string().trim().min(1, 'Name is required'), percent: percentField('Percent'), dueDate: z.string().optional() }),
    )
    .max(50),
});

function WorkOrderSheet({ open, onOpenChange, order }: { open: boolean; onOpenChange: (o: boolean) => void; order?: WorkOrder }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { projects, projectId } = useProjectContext();
  const vendors = useVendorOptions();
  const form = useForm<z.infer<typeof woForm>>({
    resolver: zodResolver(woForm),
    values: {
      projectId: order?.projectId?.id ?? projectId ?? '',
      vendorId: order?.vendorId?.id ?? '',
      title: order?.title ?? '',
      scope: order?.scope ?? '',
      amount: paiseToInput(order?.amountPaise),
      startDate: order?.startDate?.slice(0, 10) ?? '',
      endDate: order?.endDate?.slice(0, 10) ?? '',
      milestones:
        order?.milestones.map((m) => ({
          name: m.name,
          percent: m.percentBp ? String(m.percentBp / 100) : '',
          dueDate: m.dueDate?.slice(0, 10) ?? '',
        })) ?? [],
    },
  });
  const ms = useFieldArray({ control: form.control, name: 'milestones' });
  const save = useMutation({
    mutationFn: (v: z.infer<typeof woForm>) => {
      const common = {
        title: v.title,
        scope: v.scope || undefined,
        amountPaise: toPaise(v.amount),
        startDate: v.startDate || undefined,
        endDate: v.endDate || undefined,
        milestones: v.milestones.map((m) => ({
          name: m.name,
          percentBp: m.percent ? toBp(m.percent) : undefined,
          dueDate: m.dueDate || undefined,
        })),
      };
      return order
        ? api.patch<WorkOrder>(`/work-orders/${order.id}`, common)
        : api.post<WorkOrder>('/work-orders', { ...common, projectId: v.projectId, vendorId: v.vendorId });
    },
    onSuccess: (w) => {
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      toast.success(order ? 'Work order updated' : `Work order ${w.number} created`);
      onOpenChange(false);
      if (!order) navigate(`/work-orders/${w.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const e = form.formState.errors;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={order ? `Edit ${order.number}` : 'New work order'}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="wo-form" loading={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form id="wo-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <Field label="Project" htmlFor="wo-project" error={e.projectId?.message} required>
            <Select disabled={!!order} {...form.register('projectId')}>
              <option value="">Choose…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor" htmlFor="wo-vendor" error={e.vendorId?.message} required>
            <Select disabled={!!order} {...form.register('vendorId')}>
              <option value="">Choose…</option>
              {vendors.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" htmlFor="wo-title" error={e.title?.message} required className="sm:col-span-2">
            <Input {...form.register('title')} placeholder="e.g. Internal roads – phase 1" />
          </Field>
          <Field label="Contract amount" htmlFor="wo-amount" error={e.amount?.message} required>
            <MoneyInput {...form.register('amount')} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Start" htmlFor="wo-start">
              <Input type="date" {...form.register('startDate')} />
            </Field>
            <Field label="End" htmlFor="wo-end">
              <Input type="date" {...form.register('endDate')} />
            </Field>
          </div>
          <Field label="Scope of work" htmlFor="wo-scope" className="sm:col-span-2">
            <Textarea rows={3} {...form.register('scope')} />
          </Field>
          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Milestones</p>
              <Button type="button" size="sm" variant="outline" onClick={() => ms.append({ name: '', percent: '', dueDate: '' })}>
                <Plus /> Add milestone
              </Button>
            </div>
            <div className="space-y-2">
              {ms.fields.map((f, i) => (
                <div key={f.id} className="grid grid-cols-[1fr_90px_150px_auto] gap-2">
                  <Input placeholder="Milestone" aria-label="Milestone name" {...form.register(`milestones.${i}.name`)} />
                  <Input placeholder="%" aria-label="Percent" inputMode="decimal" {...form.register(`milestones.${i}.percent`)} />
                  <Input type="date" aria-label="Due date" {...form.register(`milestones.${i}.dueDate`)} />
                  <Button type="button" variant="ghost" size="icon" onClick={() => ms.remove(i)} aria-label="Remove milestone">
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

interface Costs {
  landPaidPaise: number;
  workOrders: { committedPaise: number; billedPaise: number; open: number };
  expensesPaise: number;
  byAccount: { accountId: string; code: string; name: string; amountPaise: number }[];
}

export function WorkOrdersPage() {
  const lp = useListParams();
  const navigate = useNavigate();
  const { projectId } = useProjectContext();
  const [creating, setCreating] = React.useState(false);
  const status = lp.filter('status');
  const q = useQuery({
    queryKey: ['work-orders', projectId, lp.query, status],
    queryFn: () => api.page<WorkOrder>('/work-orders', { ...lp.query, status, projectId: projectId ?? undefined }),
    placeholderData: (p) => p,
  });
  const costs = useQuery({
    queryKey: ['work-orders', 'costs', projectId],
    queryFn: () => api.get<Costs>('/work-orders/costs', { projectId: projectId ?? undefined }),
  });
  const columns: Column<WorkOrder>[] = [
    { key: 'no', header: 'Order', sortKey: 'number', cell: (w) => <span className="font-medium">{w.number}</span> },
    { key: 'title', header: 'Work', cell: (w) => w.title },
    { key: 'vendor', header: 'Vendor', cell: (w) => w.vendorId?.name ?? '—', hideOnMobile: true },
    { key: 'project', header: 'Project', cell: (w) => w.projectId?.code ?? '—', hideOnMobile: true },
    { key: 'amount', header: 'Contract', sortKey: 'amountPaise', align: 'right', cell: (w) => formatINRCompact(w.amountPaise) },
    {
      key: 'billed',
      header: 'Billed',
      align: 'right',
      cell: (w) => (
        <span className="inline-flex items-center gap-2">
          <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:inline-block">
            <span className="block h-full bg-primary" style={{ width: `${Math.min(100, (w.billedPaise * 100) / w.amountPaise)}%` }} />
          </span>
          {formatINRCompact(w.billedPaise)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      cell: (w) => <StatusBadge status={WO_VARIANT[w.status]} label={titleCase(w.status)} />,
    },
  ];
  return (
    <>
      <PageHeader
        title="Work orders"
        description="Development contracts, milestones and billing"
        actions={
          <Can permission="construction.create">
            <Button onClick={() => setCreating(true)}>
              <Plus /> New work order
            </Button>
          </Can>
        }
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Open orders" value={costs.data?.workOrders.open ?? '—'} icon={HardHat} loading={costs.isPending} />
        <StatCard
          label="Committed"
          value={costs.data ? formatINRCompact(costs.data.workOrders.committedPaise) : '—'}
          loading={costs.isPending}
        />
        <StatCard
          label="Billed"
          value={costs.data ? formatINRCompact(costs.data.workOrders.billedPaise) : '—'}
          loading={costs.isPending}
          tone="warning"
        />
        <StatCard
          label="Total development spend"
          value={costs.data ? formatINRCompact(costs.data.expensesPaise + costs.data.landPaidPaise) : '—'}
          hint={costs.data ? `incl. land ${formatINRCompact(costs.data.landPaidPaise)}` : undefined}
          loading={costs.isPending}
        />
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Order number or title" />
        <Select
          className="sm:w-44"
          value={status ?? ''}
          onChange={(e) => lp.setFilter('status', e.target.value || undefined)}
          aria-label="Status"
        >
          <option value="">All statuses</option>
          {WORK_ORDER_STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={q.data?.items}
        rowKey={(w) => w.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => q.refetch()}
        meta={q.data?.meta}
        onPageChange={lp.setPage}
        sort={lp.sort}
        onSortChange={lp.setSort}
        onRowClick={(w) => navigate(`/work-orders/${w.id}`)}
        empty={<EmptyState icon={HardHat} title="No work orders" />}
      />
      <WorkOrderSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export function WorkOrderDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [billing, setBilling] = React.useState(false);
  const [moveTo, setMoveTo] = React.useState<WorkOrderStatus | null>(null);
  const q = useQuery({ queryKey: ['work-orders', 'detail', id], queryFn: () => api.get<WorkOrder>(`/work-orders/${id}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['work-orders'] });
  const move = useMutation({
    mutationFn: (to: WorkOrderStatus) => api.post(`/work-orders/${id}/status`, { status: to }),
    onSuccess: () => {
      refresh();
      setMoveTo(null);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (m: { id: string; completed: boolean }) => api.post(`/work-orders/${id}/milestones/${m.id}`, { completed: m.completed }),
    onSuccess: refresh,
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const w = q.data;
  const pct = Math.min(100, Math.round((w.billedPaise * 100) / w.amountPaise));
  const canBill = ['issued', 'in_progress', 'completed'].includes(w.status) && can('expenses.create') && (w.remainingPaise ?? 0) > 0;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Work orders', to: '/work-orders' }, { label: w.number }]}
        title={
          <span className="flex items-center gap-3">
            {w.number} <StatusBadge status={WO_VARIANT[w.status]} label={titleCase(w.status)} />
          </span>
        }
        description={
          <>
            {w.title} ·{' '}
            <Link className="hover:underline" to={`/vendors/${w.vendorId?.id}`}>
              {w.vendorId?.name}
            </Link>{' '}
            · {w.projectId?.name}
          </>
        }
        actions={
          <>
            {can('construction.update') &&
              WORK_ORDER_TRANSITIONS[w.status].map((s) => (
                <Button
                  key={s}
                  variant={s === 'cancelled' ? 'ghost' : 'outline'}
                  className={s === 'cancelled' ? 'text-destructive' : ''}
                  onClick={() => setMoveTo(s)}
                >
                  {s === 'cancelled' ? (
                    'Cancel order'
                  ) : (
                    <>
                      Mark {titleCase(s)} <ArrowRight />
                    </>
                  )}
                </Button>
              ))}
            {canBill && (
              <Button onClick={() => setBilling(true)}>
                <Receipt /> Record bill
              </Button>
            )}
            {can('construction.update') && !['completed', 'cancelled'].includes(w.status) && (
              <Button variant="outline" size="icon" onClick={() => setEditing(true)} aria-label="Edit work order">
                <Pencil />
              </Button>
            )}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Contract" value={formatINR(w.amountPaise, { decimals: false })} />
        <StatCard label="Billed" value={formatINR(w.billedPaise, { decimals: false })} hint={`${pct}% of contract`} tone="warning" />
        <StatCard label="Remaining" value={formatINR(w.remainingPaise ?? 0, { decimals: false })} />
      </div>
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Bills</CardTitle>
            </CardHeader>
            <CardContent>
              {!w.bills?.length ? (
                <EmptyState title="No bills yet" />
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {w.bills.map((b) => (
                      <tr key={b.id} className="border-b last:border-0">
                        <td className="py-2 pr-2 font-medium">{b.number}</td>
                        <td className="py-2 pr-2">{formatDate(b.date.slice(0, 10))}</td>
                        <td className="py-2 pr-2 text-muted-foreground">
                          {b.billNumber ? `${b.billNumber} · ` : ''}
                          {b.description}
                        </td>
                        <td className="py-2 pr-2">
                          {b.status === 'reversed' ? (
                            <StatusBadge status="reversed" />
                          ) : (
                            <span className="text-xs text-muted-foreground">{b.settlement}</span>
                          )}
                        </td>
                        <td className="py-2 text-right tabular">{formatINR(b.amountPaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          {w.scope && (
            <Card>
              <CardHeader>
                <CardTitle>Scope</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="whitespace-pre-line text-sm text-muted-foreground">{w.scope}</p>
              </CardContent>
            </Card>
          )}
          <DocumentsPanel entityType="work_order" entityId={w.id} title="Contract & site documents" />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Milestones</CardTitle>
          </CardHeader>
          <CardContent>
            {!w.milestones.length ? (
              <p className="text-sm text-muted-foreground">No milestones defined.</p>
            ) : (
              <ul className="space-y-2">
                {w.milestones.map((m) => {
                  const editable = can('construction.update') && !['draft', 'cancelled'].includes(w.status);
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        disabled={!editable || toggle.isPending}
                        onClick={() => toggle.mutate({ id: m.id, completed: !m.completedAt })}
                        className="flex w-full items-start gap-2 rounded-md p-2 text-left hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent cursor-pointer"
                      >
                        {m.completedAt ? (
                          <CheckCircle2 className="mt-0.5 size-4 text-green-600" />
                        ) : (
                          <Circle className="mt-0.5 size-4 text-muted-foreground" />
                        )}
                        <span className="text-sm">
                          <span className={m.completedAt ? 'line-through decoration-muted-foreground' : 'font-medium'}>{m.name}</span>
                          {m.percentBp ? <span className="text-muted-foreground"> · {m.percentBp / 100}%</span> : null}
                          <span className="block text-xs text-muted-foreground">
                            {m.completedAt
                              ? `Done ${formatDate(m.completedAt.slice(0, 10))}`
                              : m.dueDate
                                ? `Due ${formatDate(m.dueDate.slice(0, 10))}`
                                : ''}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
      <WorkOrderSheet open={editing} onOpenChange={setEditing} order={w} />
      <ExpenseSheet
        open={billing}
        onOpenChange={setBilling}
        preset={{
          projectId: w.projectId?.id,
          vendorId: w.vendorId?.id,
          workOrderId: w.id,
          settlement: 'payable',
          description: `RA bill – ${w.title}`,
        }}
      />
      <ConfirmDialog
        open={!!moveTo}
        onOpenChange={(o) => !o && setMoveTo(null)}
        title={moveTo === 'cancelled' ? 'Cancel this work order?' : `Mark as ${titleCase(moveTo ?? '')}?`}
        destructive={moveTo === 'cancelled'}
        loading={move.isPending}
        onConfirm={() => moveTo && move.mutate(moveTo)}
      />
    </>
  );
}

// ---------------- Expenses ----------------

const expenseForm = z
  .object({
    projectId: z.string().optional(),
    vendorId: z.string().optional(),
    workOrderId: z.string().optional(),
    expenseAccountId: z.string().min(1, 'Choose an account'),
    date: z.string().min(10, 'Date is required'),
    amount: rupeeField('Amount', { min: 1 }),
    description: z.string().trim().min(1, 'Description is required').max(500),
    billNumber: z.string().max(60).optional(),
    settlement: z.enum(['paid', 'payable']),
    mode: z.enum(PAYMENT_MODES),
  })
  .refine((v) => v.settlement !== 'payable' || Boolean(v.vendorId), { path: ['vendorId'], message: 'Choose the vendor' });

export function ExpenseSheet({
  open,
  onOpenChange,
  preset,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  preset?: Partial<{ projectId: string; vendorId: string; workOrderId: string; settlement: 'paid' | 'payable'; description: string }>;
}) {
  const qc = useQueryClient();
  const { projects, projectId } = useProjectContext();
  const vendors = useVendorOptions();
  const keyRef = React.useRef(newIdempotencyKey());
  React.useEffect(() => {
    if (open) keyRef.current = newIdempotencyKey();
  }, [open]);
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: () => api.get<Account[]>('/accounting/accounts'),
    select: (rows) => rows.filter((a) => a.isActive && (a.type === 'expense' || a.systemKey === 'land_inventory')),
  });
  const form = useForm<z.infer<typeof expenseForm>>({
    resolver: zodResolver(expenseForm),
    values: {
      projectId: preset?.projectId ?? projectId ?? '',
      vendorId: preset?.vendorId ?? '',
      workOrderId: preset?.workOrderId ?? '',
      expenseAccountId: '',
      date: todayInIndia(),
      amount: '',
      description: preset?.description ?? '',
      billNumber: '',
      settlement: preset?.settlement ?? 'payable',
      mode: 'neft',
    },
  });
  const vendorId = form.watch('vendorId');
  const formProject = form.watch('projectId');
  const orders = useQuery({
    queryKey: ['work-orders', 'options', formProject, vendorId],
    queryFn: () => api.page<WorkOrder>('/work-orders', { projectId: formProject, vendorId, pageSize: 100 }),
    enabled: Boolean(formProject && vendorId),
    select: (r) => r.items.filter((w) => ['issued', 'in_progress', 'completed'].includes(w.status)),
  });
  React.useEffect(() => {
    if (accounts.data && !form.getValues('expenseAccountId')) {
      const dev = accounts.data.find((a) => a.systemKey === 'development_expense');
      if (dev) form.setValue('expenseAccountId', dev.id);
    }
  }, [accounts.data, form]);
  const save = useMutation({
    mutationFn: (v: z.infer<typeof expenseForm>) =>
      api.post<{ number: string }>(
        '/expenses',
        {
          projectId: v.projectId || undefined,
          vendorId: v.vendorId || undefined,
          workOrderId: v.workOrderId || undefined,
          expenseAccountId: v.expenseAccountId,
          date: v.date,
          amountPaise: toPaise(v.amount),
          description: v.description,
          billNumber: v.billNumber || undefined,
          settlement: v.settlement,
          mode: v.settlement === 'paid' ? v.mode : undefined,
        },
        keyRef.current,
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      qc.invalidateQueries({ queryKey: ['vendors'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(`${r.number} recorded`);
      onOpenChange(false);
    },
    onError: (e) => {
      keyRef.current = newIdempotencyKey();
      toast.error(errorMessage(e));
    },
  });
  const e = form.formState.errors;
  const settlement = form.watch('settlement');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={preset?.workOrderId ? 'Record bill' : 'Record expense'}
        description="Posted to the books immediately. Mistakes are corrected by reversal."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="expense-form" loading={save.isPending}>
              Post
            </Button>
          </>
        }
      >
        <form id="expense-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <fieldset className="sm:col-span-2">
            <legend className="mb-2 text-sm font-medium">Settlement</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" value="payable" {...form.register('settlement')} /> Vendor bill (pay later)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" value="paid" {...form.register('settlement')} /> Paid now
              </label>
            </div>
          </fieldset>
          <Field label="Project" htmlFor="ex-project">
            <Select disabled={!!preset?.projectId} {...form.register('projectId')}>
              <option value="">Company-wide</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Vendor" htmlFor="ex-vendor" error={e.vendorId?.message} required={settlement === 'payable'}>
            <Select disabled={!!preset?.vendorId} {...form.register('vendorId')}>
              <option value="">None</option>
              {vendors.data?.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Against work order" htmlFor="ex-wo" hint="Bills can never exceed the order">
            <Select disabled={!!preset?.workOrderId || !orders.data} {...form.register('workOrderId')}>
              <option value="">None</option>
              {orders.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.number} · {formatINRCompact(w.amountPaise - w.billedPaise)} left
                </option>
              ))}
              {preset?.workOrderId && !orders.data?.some((w) => w.id === preset.workOrderId) && (
                <option value={preset.workOrderId}>Selected order</option>
              )}
            </Select>
          </Field>
          <Field label="Account" htmlFor="ex-account" error={e.expenseAccountId?.message} required>
            <Select {...form.register('expenseAccountId')}>
              <option value="">Choose…</option>
              {accounts.data?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount" htmlFor="ex-amount" error={e.amount?.message} required>
            <MoneyInput {...form.register('amount')} />
          </Field>
          <Field label="Date" htmlFor="ex-date" required>
            <Input type="date" {...form.register('date')} />
          </Field>
          <Field label="Vendor bill no." htmlFor="ex-bill">
            <Input {...form.register('billNumber')} />
          </Field>
          {settlement === 'paid' && (
            <Field label="Paid by" htmlFor="ex-mode">
              <Select {...form.register('mode')}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {titleCase(m)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Description" htmlFor="ex-desc" error={e.description?.message} required className="sm:col-span-2">
            <Input {...form.register('description')} />
          </Field>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function ExpensesPage() {
  const lp = useListParams({ sort: '-date' });
  const qc = useQueryClient();
  const { projectId } = useProjectContext();
  const { can } = useAuth();
  const [creating, setCreating] = React.useState(false);
  const [reversing, setReversing] = React.useState<Expense | null>(null);
  const [reason, setReason] = React.useState('');
  const filters = { from: lp.filter('from'), to: lp.filter('to') };
  const q = useQuery({
    queryKey: ['expenses', projectId, lp.query, filters],
    queryFn: () => api.page<Expense>('/expenses', { ...lp.query, ...filters, projectId: projectId ?? undefined }),
    placeholderData: (p) => p,
  });
  const reverse = useMutation({
    mutationFn: () => api.post(`/expenses/${reversing!.id}/reverse`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['work-orders'] });
      setReversing(null);
      setReason('');
      toast.success('Expense reversed');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const columns: Column<Expense>[] = [
    { key: 'no', header: 'Number', sortKey: 'number', cell: (x) => <span className="font-medium">{x.number}</span> },
    { key: 'date', header: 'Date', sortKey: 'date', cell: (x) => formatDate(x.date.slice(0, 10)) },
    { key: 'desc', header: 'Description', cell: (x) => <span className="line-clamp-1">{x.description}</span> },
    { key: 'vendor', header: 'Vendor', cell: (x) => x.vendorId?.name ?? '—', hideOnMobile: true },
    { key: 'account', header: 'Account', cell: (x) => x.expenseAccountId?.name ?? '—', hideOnMobile: true },
    { key: 'wo', header: 'WO', cell: (x) => x.workOrderId?.number ?? '', hideOnMobile: true },
    {
      key: 'amount',
      header: 'Amount',
      sortKey: 'amountPaise',
      align: 'right',
      cell: (x) => <span className={x.status === 'reversed' ? 'text-muted-foreground line-through' : ''}>{formatINR(x.amountPaise)}</span>,
    },
    {
      key: 'actions',
      header: '',
      cell: (x) =>
        x.status === 'reversed' ? (
          <StatusBadge status="reversed" />
        ) : can('expenses.reverse') ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={(ev) => {
              ev.stopPropagation();
              setReversing(x);
            }}
          >
            <Undo2 /> Reverse
          </Button>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title="Expenses & bills"
        description="Development costs and vendor bills, posted straight to the books"
        actions={
          <Can permission="expenses.create">
            <Button onClick={() => setCreating(true)}>
              <Plus /> Record expense
            </Button>
          </Can>
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Number, description or bill no." />
        <Input
          type="date"
          className="sm:w-40"
          value={filters.from ?? ''}
          onChange={(e) => lp.setFilter('from', e.target.value || undefined)}
          aria-label="From"
        />
        <Input
          type="date"
          className="sm:w-40"
          value={filters.to ?? ''}
          onChange={(e) => lp.setFilter('to', e.target.value || undefined)}
          aria-label="To"
        />
      </div>
      <DataTable
        columns={columns}
        rows={q.data?.items}
        rowKey={(x) => x.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => q.refetch()}
        meta={q.data?.meta}
        onPageChange={lp.setPage}
        pageSize={lp.pageSize}
        onPageSizeChange={lp.setPageSize}
        sort={lp.sort}
        onSortChange={lp.setSort}
        empty={<EmptyState icon={Receipt} title="No expenses recorded" />}
      />
      <ExpenseSheet open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={!!reversing}
        onOpenChange={(o) => !o && setReversing(null)}
        title={`Reverse ${reversing?.number}?`}
        description="A reversal voucher is posted today. Bills that have already been paid cannot be reversed."
        destructive
        confirmLabel="Reverse"
        loading={reverse.isPending}
        onConfirm={() => (reason.trim() ? reverse.mutate() : toast.error('Please give a reason'))}
      >
        <Field label="Reason" htmlFor="ex-rev" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </ConfirmDialog>
    </>
  );
}
