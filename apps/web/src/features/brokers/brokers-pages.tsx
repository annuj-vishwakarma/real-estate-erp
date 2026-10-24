import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Handshake, IndianRupee, Pencil, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { PAYMENT_MODES, todayInIndia } from '@erp/shared';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatINR, titleCase } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/utils';
import { Can, useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, Sheet, SheetContent } from '@/components/ui/overlays';
import { DataTable, type Column } from '@/components/data-table';
import { DescriptionList, Field, PageHeader, StatCard, StatusBadge } from '@/components/common';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { SearchInput } from '@/components/search-input';
import { bpToInput, percentField, toBp } from '@/components/money';

interface Broker {
  id: string;
  name: string;
  phone: string;
  email?: string;
  pan?: string;
  firmName?: string;
  commissionBp: number;
  isActive: boolean;
  accruedPaise?: number;
  paidPaise?: number;
  bookings?: number;
  payableBalancePaise?: number;
  commissions?: {
    id: string;
    amountPaise: number;
    basePaise: number;
    rateBp: number;
    status: string;
    createdAt: string;
    bookingId?: { id: string; bookingNumber: string; status: string; customerId?: { name: string } };
    projectId?: { name: string; code: string };
    payout?: { number: string; paidOn: string };
  }[];
}

const brokerForm = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\s-]{6,16}$/, 'Enter a valid phone number'),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional(),
  pan: z
    .string()
    .trim()
    .regex(/^([A-Za-z]{5}[0-9]{4}[A-Za-z])?$/, 'Enter a valid PAN')
    .optional(),
  firmName: z.string().max(120).optional(),
  commission: percentField('Commission'),
  isActive: z.boolean(),
});

function BrokerSheet({ open, onOpenChange, broker }: { open: boolean; onOpenChange: (o: boolean) => void; broker?: Broker }) {
  const qc = useQueryClient();
  const form = useForm<z.infer<typeof brokerForm>>({
    resolver: zodResolver(brokerForm),
    values: {
      name: broker?.name ?? '',
      phone: broker?.phone ?? '',
      email: broker?.email ?? '',
      pan: broker?.pan ?? '',
      firmName: broker?.firmName ?? '',
      commission: bpToInput(broker?.commissionBp) || '',
      isActive: broker?.isActive ?? true,
    },
  });
  const save = useMutation({
    mutationFn: (v: z.infer<typeof brokerForm>) => {
      const payload = {
        name: v.name,
        phone: v.phone,
        email: v.email || undefined,
        pan: v.pan ? v.pan.toUpperCase() : undefined,
        firmName: v.firmName || undefined,
        commissionBp: toBp(v.commission),
        isActive: v.isActive,
      };
      return broker ? api.patch(`/brokers/${broker.id}`, payload) : api.post('/brokers', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['brokers'] });
      toast.success('Broker saved');
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const e = form.formState.errors;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={broker ? `Edit ${broker.name}` : 'New broker'}
        description="Commission accrues automatically when a booking introduced by this broker is confirmed."
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="broker-form" loading={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form id="broker-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <Field label="Name" htmlFor="br-name" error={e.name?.message} required className="sm:col-span-2">
            <Input {...form.register('name')} />
          </Field>
          <Field label="Phone" htmlFor="br-phone" error={e.phone?.message} required>
            <Input type="tel" {...form.register('phone')} />
          </Field>
          <Field label="Email" htmlFor="br-email" error={e.email?.message}>
            <Input type="email" {...form.register('email')} />
          </Field>
          <Field label="Firm" htmlFor="br-firm">
            <Input {...form.register('firmName')} />
          </Field>
          <Field label="PAN" htmlFor="br-pan" error={e.pan?.message}>
            <Input className="uppercase" {...form.register('pan')} />
          </Field>
          <Field label="Commission (%)" htmlFor="br-comm" error={e.commission?.message} hint="Of plot value after discount">
            <Input inputMode="decimal" {...form.register('commission')} />
          </Field>
          <div className="flex items-center gap-2 self-end pb-2">
            <Checkbox id="br-active" checked={form.watch('isActive')} onCheckedChange={(c) => form.setValue('isActive', c === true)} />
            <Label htmlFor="br-active">Active</Label>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function BrokersPage() {
  const navigate = useNavigate();
  const [q, setQ] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const list = useQuery({
    queryKey: ['brokers', q],
    queryFn: () => api.get<Broker[]>('/brokers', { q: q || undefined, includeInactive: true }),
  });
  const columns: Column<Broker>[] = [
    { key: 'name', header: 'Broker', cell: (b) => <span className="font-medium">{b.name}</span> },
    { key: 'firm', header: 'Firm', cell: (b) => b.firmName ?? '—', hideOnMobile: true },
    { key: 'phone', header: 'Phone', cell: (b) => b.phone },
    { key: 'rate', header: 'Rate', align: 'right', cell: (b) => `${b.commissionBp / 100}%` },
    { key: 'bookings', header: 'Bookings', align: 'right', cell: (b) => b.bookings ?? 0, hideOnMobile: true },
    { key: 'due', header: 'Payable', align: 'right', cell: (b) => formatINR(b.accruedPaise ?? 0, { decimals: false }) },
    { key: 'paid', header: 'Paid', align: 'right', cell: (b) => formatINR(b.paidPaise ?? 0, { decimals: false }), hideOnMobile: true },
    { key: 'status', header: '', cell: (b) => (b.isActive ? null : <StatusBadge status="disabled" />) },
  ];
  const totalDue = list.data?.reduce((s, b) => s + (b.accruedPaise ?? 0), 0) ?? 0;
  return (
    <>
      <PageHeader
        title="Brokers"
        description="Channel partners and their commissions"
        actions={
          <Can permission="brokers.create">
            <Button onClick={() => setCreating(true)}>
              <Plus /> New broker
            </Button>
          </Can>
        }
      />
      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <StatCard
          label="Commission payable"
          value={formatINR(totalDue, { decimals: false })}
          icon={IndianRupee}
          tone={totalDue ? 'warning' : 'default'}
          loading={list.isPending}
        />
        <StatCard label="Brokers" value={list.data?.filter((b) => b.isActive).length ?? '—'} icon={Handshake} loading={list.isPending} />
      </div>
      <div className="mb-4">
        <SearchInput value={q} onChange={setQ} placeholder="Name, phone or firm" />
      </div>
      <DataTable
        columns={columns}
        rows={list.data}
        rowKey={(b) => b.id}
        loading={list.isPending}
        error={list.error}
        onRetry={() => list.refetch()}
        onRowClick={(b) => navigate(`/brokers/${b.id}`)}
        empty={<EmptyState icon={Handshake} title="No brokers yet" />}
      />
      <BrokerSheet open={creating} onOpenChange={setCreating} />
    </>
  );
}

export function BrokerDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [paying, setPaying] = React.useState(false);
  const [paidOn, setPaidOn] = React.useState(todayInIndia());
  const [mode, setMode] = React.useState('neft');
  const [reference, setReference] = React.useState('');
  const keyRef = React.useRef(newIdempotencyKey());
  const q = useQuery({ queryKey: ['brokers', 'detail', id], queryFn: () => api.get<Broker>(`/brokers/${id}`) });
  const payout = useMutation({
    mutationFn: () =>
      api.post<{ number: string; totalPaise: number }>(
        `/brokers/${id}/payouts`,
        { commissionIds: [...selected], paidOn, mode, reference: reference || undefined },
        keyRef.current,
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['brokers'] });
      setPaying(false);
      setSelected(new Set());
      setReference('');
      toast.success(`Payout ${r.number} of ${formatINR(r.totalPaise)} recorded`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const b = q.data;
  const accrued = b.commissions?.filter((c) => c.status === 'accrued') ?? [];
  const selectedTotal = accrued.filter((c) => selected.has(c.id)).reduce((s, c) => s + c.amountPaise, 0);
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Brokers', to: '/brokers' }, { label: b.name }]}
        title={b.name}
        description={`${b.firmName ? `${b.firmName} · ` : ''}${b.phone} · ${b.commissionBp / 100}% commission`}
        actions={
          <>
            <Can permission="brokers.update">
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </Can>
            {can('brokers.payout') && (
              <Button
                disabled={selected.size === 0}
                onClick={() => {
                  keyRef.current = newIdempotencyKey();
                  setPaying(true);
                }}
              >
                <IndianRupee /> Pay {selected.size ? formatINR(selectedTotal, { decimals: false }) : 'selected'}
              </Button>
            )}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatCard label="Payable now" value={formatINR(b.payableBalancePaise ?? 0, { decimals: false })} tone="warning" />
        <StatCard
          label="Paid to date"
          value={formatINR(b.commissions?.filter((c) => c.status === 'paid').reduce((s, c) => s + c.amountPaise, 0) ?? 0, {
            decimals: false,
          })}
          tone="success"
        />
        <StatCard label="Bookings introduced" value={b.commissions?.filter((c) => c.status !== 'cancelled').length ?? 0} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Commissions</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {!b.commissions?.length ? (
            <EmptyState
              title="No commissions yet"
              description="Choose this broker on a booking; commission accrues when the booking is confirmed."
            />
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="w-8 py-2" />
                  <th className="py-2 pr-2">Booking</th>
                  <th className="py-2 pr-2">Customer</th>
                  <th className="py-2 pr-2 text-right">Base</th>
                  <th className="py-2 pr-2 text-right">Commission</th>
                  <th className="py-2 pr-2">Status</th>
                  <th className="py-2">Payout</th>
                </tr>
              </thead>
              <tbody>
                {b.commissions.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-2">
                      {c.status === 'accrued' && can('brokers.payout') && (
                        <Checkbox
                          checked={selected.has(c.id)}
                          onCheckedChange={(v) =>
                            setSelected((s) => {
                              const n = new Set(s);
                              if (v) n.add(c.id);
                              else n.delete(c.id);
                              return n;
                            })
                          }
                          aria-label={`Select commission for ${c.bookingId?.bookingNumber}`}
                        />
                      )}
                    </td>
                    <td className="py-2 pr-2">
                      {c.bookingId ? (
                        <Link className="font-medium hover:underline" to={`/bookings/${c.bookingId.id}`}>
                          {c.bookingId.bookingNumber}
                        </Link>
                      ) : (
                        '—'
                      )}
                      <span className="block text-xs text-muted-foreground">{c.projectId?.name}</span>
                    </td>
                    <td className="py-2 pr-2">{c.bookingId?.customerId?.name ?? '—'}</td>
                    <td className="py-2 pr-2 text-right tabular">{formatINR(c.basePaise, { decimals: false })}</td>
                    <td className="py-2 pr-2 text-right tabular">
                      {formatINR(c.amountPaise)} <span className="text-xs text-muted-foreground">@{c.rateBp / 100}%</span>
                    </td>
                    <td className="py-2 pr-2">
                      <StatusBadge status={c.status === 'accrued' ? 'pending' : c.status} />
                    </td>
                    <td className="py-2 text-muted-foreground">
                      {c.payout ? `${c.payout.number} · ${formatDate(c.payout.paidOn.slice(0, 10))}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      <Card className="mt-4">
        <CardContent className="pt-5">
          <DescriptionList
            items={[
              { label: 'Email', value: b.email },
              { label: 'PAN', value: b.pan },
              { label: 'Status', value: b.isActive ? 'Active' : 'Inactive' },
            ]}
          />
        </CardContent>
      </Card>
      <BrokerSheet open={editing} onOpenChange={setEditing} broker={b} />
      <Dialog open={paying} onOpenChange={setPaying}>
        <DialogContent title="Pay commissions" description={`${selected.size} booking(s) · ${formatINR(selectedTotal)}`}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Paid on" htmlFor="bp-date">
              <Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </Field>
            <Field label="Mode" htmlFor="bp-mode">
              <Select value={mode} onChange={(e) => setMode(e.target.value)}>
                {PAYMENT_MODES.map((m) => (
                  <option key={m} value={m}>
                    {titleCase(m)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Reference" htmlFor="bp-ref" className="sm:col-span-2">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </Field>
          </div>
          <DialogFooter>
            <Button loading={payout.isPending} onClick={() => payout.mutate()}>
              Record payout
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
