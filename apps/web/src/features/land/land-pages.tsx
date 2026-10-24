import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowRight, IndianRupee, MapPinned, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { LAND_AREA_UNITS, LAND_STATUSES, LAND_TRANSITIONS, PAYMENT_MODES, todayInIndia, type LandStatus } from '@erp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatDateTime, formatINR, formatINRCompact, titleCase } from '@/lib/format';
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
import { MoneyInput, paiseToInput, rupeeField, toPaise } from '@/components/money';

interface Parcel {
  id: string;
  khasraNumber: string;
  khataNumber?: string;
  village: string;
  tehsil?: string;
  district: string;
  state: string;
  areaX100: number;
  areaUnit: string;
  owners: { name: string; sharePercentBp?: number; phone?: string }[];
  status: LandStatus;
  agreedCostPaise?: number;
  paidPaise: number;
  balancePaise?: number | null;
  agreementDate?: string;
  registryDate?: string;
  mutationDone: boolean;
  notes?: string;
  projectId?: { id: string; name: string; code: string } | null;
  statusHistory?: { from?: string; to: string; note?: string; at: string; by?: { name: string } }[];
  payments?: {
    id: string;
    number: string;
    amountPaise: number;
    date: string;
    mode: string;
    payee?: string;
    reference?: string;
    accountId?: { code: string; name: string };
  }[];
}

const STATUS_VARIANT: Record<LandStatus, string> = {
  negotiation: 'pending',
  agreement: 'partial',
  registered: 'active',
  converted: 'completed',
  dropped: 'cancelled',
};
const area = (p: Pick<Parcel, 'areaX100' | 'areaUnit'>) => `${(p.areaX100 / 100).toLocaleString('en-IN')} ${p.areaUnit}`;

const parcelForm = z.object({
  khasraNumber: z.string().trim().min(1, 'Khasra number is required').max(40),
  khataNumber: z.string().max(40).optional(),
  village: z.string().trim().min(1, 'Village is required').max(100),
  tehsil: z.string().max(100).optional(),
  district: z.string().trim().min(1, 'District is required').max(100),
  state: z.string().trim().min(1, 'State is required').max(100),
  area: z
    .string()
    .trim()
    .regex(/^\d+(\.\d{1,2})?$/, 'Up to 2 decimals')
    .refine((v) => Number(v) > 0, 'Area must be above zero'),
  areaUnit: z.enum(LAND_AREA_UNITS),
  projectId: z.string().optional(),
  agreedCost: rupeeField('Agreed cost', { required: false }),
  mutationDone: z.boolean(),
  notes: z.string().max(2000).optional(),
  owners: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Owner name is required'),
        share: z.string().regex(/^(\d{1,3}(\.\d{1,2})?)?$/, '0–100'),
        phone: z.string().optional(),
      }),
    )
    .max(20),
});
type ParcelForm = z.infer<typeof parcelForm>;

function ParcelSheet({ open, onOpenChange, parcel }: { open: boolean; onOpenChange: (o: boolean) => void; parcel?: Parcel }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { projects } = useProjectContext();
  const form = useForm<ParcelForm>({
    resolver: zodResolver(parcelForm),
    values: {
      khasraNumber: parcel?.khasraNumber ?? '',
      khataNumber: parcel?.khataNumber ?? '',
      village: parcel?.village ?? '',
      tehsil: parcel?.tehsil ?? '',
      district: parcel?.district ?? '',
      state: parcel?.state ?? '',
      area: parcel ? String(parcel.areaX100 / 100) : '',
      areaUnit: (parcel?.areaUnit as ParcelForm['areaUnit']) ?? 'acre',
      projectId: parcel?.projectId?.id ?? '',
      agreedCost: paiseToInput(parcel?.agreedCostPaise),
      mutationDone: parcel?.mutationDone ?? false,
      notes: parcel?.notes ?? '',
      owners: parcel?.owners.map((o) => ({
        name: o.name,
        share: o.sharePercentBp ? String(o.sharePercentBp / 100) : '',
        phone: o.phone ?? '',
      })) ?? [{ name: '', share: '100', phone: '' }],
    },
  });
  const owners = useFieldArray({ control: form.control, name: 'owners' });
  const save = useMutation({
    mutationFn: (v: ParcelForm) => {
      const [w, f = ''] = v.area.split('.');
      const payload = {
        khasraNumber: v.khasraNumber,
        khataNumber: v.khataNumber || undefined,
        village: v.village,
        tehsil: v.tehsil || undefined,
        district: v.district,
        state: v.state,
        areaX100: Number(w) * 100 + Number((f + '00').slice(0, 2)),
        areaUnit: v.areaUnit,
        projectId: v.projectId || undefined,
        agreedCostPaise: v.agreedCost ? toPaise(v.agreedCost) : undefined,
        mutationDone: v.mutationDone,
        notes: v.notes || undefined,
        owners: v.owners.map((o) => ({
          name: o.name,
          sharePercentBp: o.share ? toPaise(o.share) : undefined,
          phone: o.phone || undefined,
        })),
      };
      return parcel ? api.patch<Parcel>(`/land/${parcel.id}`, payload) : api.post<Parcel>('/land', payload);
    },
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['land'] });
      toast.success(parcel ? 'Parcel updated' : 'Parcel recorded');
      onOpenChange(false);
      if (!parcel) navigate(`/land/${p.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const e = form.formState.errors;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={parcel ? `Edit khasra ${parcel.khasraNumber}` : 'Record land parcel'}
        className="sm:max-w-2xl"
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="parcel-form" loading={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form id="parcel-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <Field label="Khasra / survey no." htmlFor="lp-khasra" error={e.khasraNumber?.message} required>
            <Input {...form.register('khasraNumber')} />
          </Field>
          <Field label="Khata no." htmlFor="lp-khata">
            <Input {...form.register('khataNumber')} />
          </Field>
          <Field label="Village" htmlFor="lp-village" error={e.village?.message} required>
            <Input {...form.register('village')} />
          </Field>
          <Field label="Tehsil" htmlFor="lp-tehsil">
            <Input {...form.register('tehsil')} />
          </Field>
          <Field label="District" htmlFor="lp-district" error={e.district?.message} required>
            <Input {...form.register('district')} />
          </Field>
          <Field label="State" htmlFor="lp-state" error={e.state?.message} required>
            <Input {...form.register('state')} />
          </Field>
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <Field label="Area" htmlFor="lp-area" error={e.area?.message} required>
              <Input inputMode="decimal" {...form.register('area')} />
            </Field>
            <Field label="Unit" htmlFor="lp-unit">
              <Select {...form.register('areaUnit')}>
                {LAND_AREA_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Agreed cost" htmlFor="lp-cost" error={e.agreedCost?.message} hint="Payments to owners are capped at this amount">
            <MoneyInput {...form.register('agreedCost')} />
          </Field>
          <Field label="Linked project" htmlFor="lp-project" hint="Optional until the land is developed" className="sm:col-span-2">
            <Select {...form.register('projectId')}>
              <option value="">Not linked yet</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Owners</p>
              <Button type="button" size="sm" variant="outline" onClick={() => owners.append({ name: '', share: '', phone: '' })}>
                <Plus /> Add owner
              </Button>
            </div>
            <div className="space-y-2">
              {owners.fields.map((f, i) => (
                <div key={f.id} className="grid grid-cols-[1fr_90px_1fr_auto] gap-2">
                  <Input
                    placeholder="Name"
                    aria-label="Owner name"
                    {...form.register(`owners.${i}.name`)}
                    aria-invalid={e.owners?.[i]?.name ? true : undefined}
                  />
                  <Input placeholder="Share %" aria-label="Share percent" inputMode="decimal" {...form.register(`owners.${i}.share`)} />
                  <Input placeholder="Phone" aria-label="Owner phone" {...form.register(`owners.${i}.phone`)} />
                  <Button type="button" variant="ghost" size="icon" onClick={() => owners.remove(i)} aria-label="Remove owner">
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox
              id="lp-mutation"
              checked={form.watch('mutationDone')}
              onCheckedChange={(c) => form.setValue('mutationDone', c === true)}
            />
            <Label htmlFor="lp-mutation">Mutation (naamantaran) completed</Label>
          </div>
          <Field label="Notes" htmlFor="lp-notes" className="sm:col-span-2">
            <Textarea rows={3} {...form.register('notes')} />
          </Field>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function LandPage() {
  const lp = useListParams();
  const navigate = useNavigate();
  const { projectId } = useProjectContext();
  const [creating, setCreating] = React.useState(false);
  const status = lp.filter('status');
  const q = useQuery({
    queryKey: ['land', projectId, lp.query, status],
    queryFn: () => api.page<Parcel>('/land', { ...lp.query, status, projectId: projectId ?? undefined }),
    placeholderData: (p) => p,
  });
  const summary = useQuery({
    queryKey: ['land', 'summary', projectId],
    queryFn: () =>
      api.get<{ agreedCostPaise: number; paidPaise: number; parcels: number }>('/land/summary', { projectId: projectId ?? undefined }),
  });
  const columns: Column<Parcel>[] = [
    { key: 'khasra', header: 'Khasra', sortKey: 'khasraNumber', cell: (p) => <span className="font-medium">{p.khasraNumber}</span> },
    { key: 'village', header: 'Village', sortKey: 'village', cell: (p) => `${p.village}, ${p.district}` },
    { key: 'area', header: 'Area', align: 'right', cell: area, hideOnMobile: true },
    { key: 'owners', header: 'Owners', cell: (p) => p.owners.map((o) => o.name).join(', ') || '—', hideOnMobile: true },
    { key: 'project', header: 'Project', cell: (p) => p.projectId?.code ?? '—', hideOnMobile: true },
    {
      key: 'cost',
      header: 'Agreed',
      sortKey: 'agreedCostPaise',
      align: 'right',
      cell: (p) => (p.agreedCostPaise ? formatINRCompact(p.agreedCostPaise) : '—'),
    },
    { key: 'paid', header: 'Paid', align: 'right', cell: (p) => formatINRCompact(p.paidPaise), hideOnMobile: true },
    {
      key: 'status',
      header: 'Status',
      sortKey: 'status',
      cell: (p) => <StatusBadge status={STATUS_VARIANT[p.status]} label={titleCase(p.status)} />,
    },
  ];
  return (
    <>
      <PageHeader
        title="Land acquisition"
        description="Parcels under negotiation, agreement and registry"
        actions={
          <Can permission="land.create">
            <Button onClick={() => setCreating(true)}>
              <Plus /> Record parcel
            </Button>
          </Can>
        }
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-3">
        <StatCard label="Active parcels" value={summary.data?.parcels ?? '—'} loading={summary.isPending} icon={MapPinned} />
        <StatCard
          label="Agreed cost"
          value={summary.data ? formatINRCompact(summary.data.agreedCostPaise) : '—'}
          loading={summary.isPending}
          icon={IndianRupee}
        />
        <StatCard
          label="Paid to owners"
          value={summary.data ? formatINRCompact(summary.data.paidPaise) : '—'}
          hint={summary.data ? `Balance ${formatINRCompact(summary.data.agreedCostPaise - summary.data.paidPaise)}` : undefined}
          loading={summary.isPending}
          tone="success"
        />
      </div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Khasra, village, district or owner" />
        <Select
          className="sm:w-44"
          value={status ?? ''}
          onChange={(e) => lp.setFilter('status', e.target.value || undefined)}
          aria-label="Status"
        >
          <option value="">All statuses</option>
          {LAND_STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={q.data?.items}
        rowKey={(p) => p.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => q.refetch()}
        meta={q.data?.meta}
        onPageChange={lp.setPage}
        pageSize={lp.pageSize}
        onPageSizeChange={lp.setPageSize}
        sort={lp.sort}
        onSortChange={lp.setSort}
        onRowClick={(p) => navigate(`/land/${p.id}`)}
        empty={<EmptyState icon={MapPinned} title="No land parcels" description="Record parcels as soon as negotiations start." />}
      />
      <ParcelSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

const payForm = z.object({
  amount: rupeeField('Amount', { min: 1 }),
  paidOn: z.string().min(10, 'Date is required'),
  mode: z.enum(PAYMENT_MODES),
  payee: z.string().max(120).optional(),
  reference: z.string().max(100).optional(),
});

export function LandDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [paying, setPaying] = React.useState(false);
  const [moveTo, setMoveTo] = React.useState<LandStatus | null>(null);
  const [note, setNote] = React.useState('');
  const [deleting, setDeleting] = React.useState(false);
  const keyRef = React.useRef(newIdempotencyKey());
  const q = useQuery({ queryKey: ['land', 'detail', id], queryFn: () => api.get<Parcel>(`/land/${id}`) });
  const form = useForm<z.infer<typeof payForm>>({
    resolver: zodResolver(payForm),
    defaultValues: { amount: '', paidOn: todayInIndia(), mode: 'rtgs', payee: '', reference: '' },
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['land'] });
  const pay = useMutation({
    mutationFn: (v: z.infer<typeof payForm>) =>
      api.post<{ number: string }>(
        `/land/${id}/payments`,
        {
          amountPaise: toPaise(v.amount),
          paidOn: v.paidOn,
          mode: v.mode,
          payee: v.payee || undefined,
          reference: v.reference || undefined,
        },
        keyRef.current,
      ),
    onSuccess: (p) => {
      refresh();
      setPaying(false);
      form.reset({ amount: '', paidOn: todayInIndia(), mode: 'rtgs' });
      toast.success(`Payment ${p.number} recorded`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const move = useMutation({
    mutationFn: (to: LandStatus) => api.post(`/land/${id}/status`, { status: to, note: note || undefined }),
    onSuccess: () => {
      refresh();
      setMoveTo(null);
      setNote('');
      toast.success('Status updated');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/land/${id}`),
    onSuccess: () => {
      refresh();
      navigate('/land');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data;
  const next = LAND_TRANSITIONS[p.status];
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Land', to: '/land' }, { label: `Khasra ${p.khasraNumber}` }]}
        title={
          <span className="flex items-center gap-3">
            Khasra {p.khasraNumber} <StatusBadge status={STATUS_VARIANT[p.status]} label={titleCase(p.status)} />
          </span>
        }
        description={`${p.village}${p.tehsil ? `, ${p.tehsil}` : ''}, ${p.district}, ${p.state} · ${area(p)}`}
        actions={
          <>
            {can('land.update') &&
              next.map((s) => (
                <Button
                  key={s}
                  variant={s === 'dropped' ? 'ghost' : 'outline'}
                  className={s === 'dropped' ? 'text-destructive' : ''}
                  onClick={() => setMoveTo(s)}
                >
                  {s === 'dropped' ? (
                    'Drop'
                  ) : (
                    <>
                      Move to {titleCase(s)} <ArrowRight />
                    </>
                  )}
                </Button>
              ))}
            {can('land.pay') && ['agreement', 'registered', 'converted'].includes(p.status) && (
              <Button
                onClick={() => {
                  keyRef.current = newIdempotencyKey();
                  setPaying(true);
                }}
              >
                <IndianRupee /> Pay owners
              </Button>
            )}
            <Can permission="land.update">
              <Button variant="outline" size="icon" onClick={() => setEditing(true)} aria-label="Edit parcel">
                <Pencil />
              </Button>
            </Can>
            {can('land.delete') && p.paidPaise === 0 && (
              <Button variant="ghost" size="icon" onClick={() => setDeleting(true)} aria-label="Delete parcel">
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Agreed cost" value={p.agreedCostPaise ? formatINR(p.agreedCostPaise, { decimals: false }) : 'Not set'} />
        <StatCard label="Paid to owners" value={formatINR(p.paidPaise, { decimals: false })} tone="success" />
        <StatCard
          label="Balance"
          value={p.balancePaise != null ? formatINR(p.balancePaise, { decimals: false }) : '—'}
          tone={p.balancePaise ? 'warning' : 'default'}
        />
      </div>
      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <Card>
            <CardContent className="pt-5">
              <DescriptionList
                items={[
                  {
                    label: 'Owners',
                    value: p.owners.map((o) => `${o.name}${o.sharePercentBp ? ` (${o.sharePercentBp / 100}%)` : ''}`).join(', ') || '—',
                  },
                  { label: 'Khata', value: p.khataNumber },
                  { label: 'Project', value: p.projectId?.name ?? 'Not linked' },
                  { label: 'Agreement date', value: p.agreementDate ? formatDate(p.agreementDate.slice(0, 10)) : '—' },
                  { label: 'Registry date', value: p.registryDate ? formatDate(p.registryDate.slice(0, 10)) : '—' },
                  { label: 'Mutation', value: p.mutationDone ? 'Completed' : 'Pending' },
                ]}
              />
              {p.notes && <p className="mt-4 whitespace-pre-line text-sm text-muted-foreground">{p.notes}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Payments to owners</CardTitle>
            </CardHeader>
            <CardContent>
              {!p.payments?.length ? (
                <EmptyState title="No payments yet" description="Payments are posted to Land & Development (WIP)." />
              ) : (
                <table className="w-full text-sm">
                  <tbody>
                    {p.payments.map((x) => (
                      <tr key={x.id} className="border-b last:border-0">
                        <td className="py-2 pr-2 font-medium">{x.number}</td>
                        <td className="py-2 pr-2">{formatDate(x.date.slice(0, 10))}</td>
                        <td className="py-2 pr-2 text-muted-foreground">
                          {x.payee ?? ''} {x.mode.toUpperCase()} {x.reference ?? ''}
                        </td>
                        <td className="py-2 text-right tabular">{formatINR(x.amountPaise)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>
          <DocumentsPanel entityType="land_parcel" entityId={p.id} title="Title documents" />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>History</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="relative space-y-3 border-l pl-4">
              {p.statusHistory?.map((h, i) => (
                <li key={i} className="relative text-sm">
                  <span className="absolute -left-[22.5px] top-1 size-3 rounded-full border-2 border-card bg-primary" aria-hidden />
                  <p className="font-medium">{titleCase(h.to)}</p>
                  <p className="text-xs text-muted-foreground">
                    {h.note ? `${h.note} · ` : ''}
                    {h.by?.name ?? ''} · {formatDateTime(h.at)}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </div>

      <ParcelSheet open={editing} onOpenChange={setEditing} parcel={p} />
      <Dialog open={paying} onOpenChange={setPaying}>
        <DialogContent title="Pay land owners" description={p.balancePaise != null ? `Balance ${formatINR(p.balancePaise)}` : undefined}>
          <form className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => pay.mutate(v))} noValidate>
            <Field label="Amount" htmlFor="lpay-amount" error={form.formState.errors.amount?.message} required>
              <MoneyInput {...form.register('amount')} />
            </Field>
            <Field label="Paid on" htmlFor="lpay-date" required>
              <Input type="date" {...form.register('paidOn')} />
            </Field>
            <Field label="Mode" htmlFor="lpay-mode">
              <Select {...form.register('mode')}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {titleCase(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Payee" htmlFor="lpay-payee">
              <Input {...form.register('payee')} placeholder={p.owners[0]?.name} />
            </Field>
            <Field label="Reference / UTR / cheque" htmlFor="lpay-ref" className="sm:col-span-2">
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
      <ConfirmDialog
        open={!!moveTo}
        onOpenChange={(o) => !o && setMoveTo(null)}
        title={moveTo === 'dropped' ? 'Drop this parcel?' : `Move to ${titleCase(moveTo ?? '')}?`}
        description={
          moveTo === 'dropped' ? 'Dropped parcels are kept for history but closed.' : 'The date is recorded as today if not already set.'
        }
        destructive={moveTo === 'dropped'}
        loading={move.isPending}
        onConfirm={() => moveTo && move.mutate(moveTo)}
      >
        <Field label="Note" htmlFor="land-note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete this parcel?"
        destructive
        confirmLabel="Delete"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </>
  );
}
