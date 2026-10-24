import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { BadgeCheck, Ban, Download, FileText, IndianRupee, Plus, ReceiptIndianRupee, Trash2, Undo2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { BOOKING_STATUSES, todayInIndia, type ScheduledInstallment } from '@erp/shared';
import { api, download, errorMessage } from '@/lib/api';
import { areaToSqft, formatDate, formatDateTime, formatINR, titleCase } from '@/lib/format';
import { newIdempotencyKey } from '@/lib/utils';
import { useDebounced, useListParams } from '@/hooks/use-list-params';
import { useProjectContext } from '@/hooks/use-project';
import { Can, useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select, Textarea } from '@/components/ui/primitives';
import { ConfirmDialog } from '@/components/ui/overlays';
import { DataTable, type Column } from '@/components/data-table';
import { DescriptionList, Field, PageHeader, StatCard, StatusBadge } from '@/components/common';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { SearchInput } from '@/components/search-input';
import { MoneyInput, toPaise } from '@/components/money';
import { DocumentsPanel } from '@/components/documents-panel';
import type { Customer } from '@/features/customers/customers-pages';
import { CustomerFormSheet } from '@/features/customers/customers-pages';
import type { PaymentPlan } from './payment-plans-page';
import type { Plot } from '@/features/inventory/plot-drawer';
import { RecordPaymentDialog, RefundDialog } from '@/features/payments/payment-dialogs';

interface BookingRow {
  id: string;
  bookingNumber: string;
  status: string;
  bookingDate: string;
  netAmountPaise: number;
  allocatedPaise: number;
  receivedPaise: number;
  plots: string[];
  customerId?: { id: string; name: string; phone: string };
  projectId?: { id: string; name: string; code: string };
}

export function BookingsPage() {
  const lp = useListParams({ sort: '-createdAt' });
  const navigate = useNavigate();
  const { projectId } = useProjectContext();
  const status = lp.filter('status');
  const q = useQuery({
    queryKey: ['bookings', projectId, lp.query, status],
    queryFn: () => api.page<BookingRow>('/bookings', { ...lp.query, status, projectId: projectId ?? undefined }),
    placeholderData: (p) => p,
  });
  const columns: Column<BookingRow>[] = [
    { key: 'no', header: 'Booking', sortKey: 'bookingNumber', cell: (b) => <span className="font-medium">{b.bookingNumber}</span> },
    { key: 'date', header: 'Date', sortKey: 'bookingDate', cell: (b) => formatDate(b.bookingDate.slice(0, 10)), hideOnMobile: true },
    { key: 'customer', header: 'Customer', cell: (b) => b.customerId?.name ?? '—' },
    { key: 'project', header: 'Project', cell: (b) => b.projectId?.code ?? '—', hideOnMobile: true },
    { key: 'plots', header: 'Plots', cell: (b) => b.plots.join(', '), hideOnMobile: true },
    {
      key: 'net',
      header: 'Amount',
      sortKey: 'netAmountPaise',
      align: 'right',
      cell: (b) => formatINR(b.netAmountPaise, { decimals: false }),
    },
    {
      key: 'paid',
      header: 'Paid',
      align: 'right',
      hideOnMobile: true,
      cell: (b) => (
        <span className="text-muted-foreground">{b.netAmountPaise ? Math.floor((b.allocatedPaise * 100) / b.netAmountPaise) : 0}%</span>
      ),
    },
    { key: 'status', header: 'Status', sortKey: 'status', cell: (b) => <StatusBadge status={b.status} kind="booking" /> },
  ];
  return (
    <>
      <PageHeader
        title="Bookings"
        description="Reservations, bookings and allotments"
        actions={
          <>
            <Can permission="reports.export">
              <Button
                variant="outline"
                onClick={() =>
                  void download('/bookings/export.xlsx', { status, q: lp.q, projectId: projectId ?? undefined }).catch((e) =>
                    toast.error(errorMessage(e)),
                  )
                }
              >
                <Download /> Excel
              </Button>
            </Can>
            <Can permission="bookings.create">
              <Button onClick={() => navigate(`/bookings/new${projectId ? `?project=${projectId}` : ''}`)}>
                <Plus /> New booking
              </Button>
            </Can>
          </>
        }
      />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Booking no., customer name or phone" />
        <Select
          className="sm:w-44"
          value={status ?? ''}
          onChange={(e) => lp.setFilter('status', e.target.value || undefined)}
          aria-label="Status filter"
        >
          <option value="">All statuses</option>
          {BOOKING_STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={q.data?.items}
        rowKey={(b) => b.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => q.refetch()}
        meta={q.data?.meta}
        onPageChange={lp.setPage}
        pageSize={lp.pageSize}
        onPageSizeChange={lp.setPageSize}
        sort={lp.sort}
        onSortChange={lp.setSort}
        onRowClick={(b) => navigate(`/bookings/${b.id}`)}
        empty={<EmptyState title="No bookings found" />}
      />
    </>
  );
}

interface Quote {
  items: {
    plotId: string;
    plotNumber: string;
    blockCode?: string;
    areaX100: number;
    ratePaisePerSqft: number;
    basePaise: number;
    plcPaise: number;
    lineTotalPaise: number;
  }[];
  unavailable: { plotNumber: string; status: string }[];
  grossAmountPaise: number;
  discountPaise: number;
  chargesTotalPaise: number;
  netAmountPaise: number;
  schedule: ScheduledInstallment[];
  planName: string;
}

export function NewBookingPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const { projects, projectId: ctxProject } = useProjectContext();
  const [projectId, setProjectId] = React.useState(params.get('project') ?? ctxProject ?? '');
  const [customer, setCustomer] = React.useState<Pick<Customer, 'id' | 'name' | 'phone' | 'customerCode'> | null>(null);
  const [customerQuery, setCustomerQuery] = React.useState('');
  const [newCustomer, setNewCustomer] = React.useState(false);
  const [plotIds, setPlotIds] = React.useState<string[]>(params.get('plots')?.split(',').filter(Boolean) ?? []);
  const [plotFilter, setPlotFilter] = React.useState('');
  const [planId, setPlanId] = React.useState('');
  const [bookingDate, setBookingDate] = React.useState(todayInIndia());
  const [mode, setMode] = React.useState<'book' | 'reserve'>('book');
  const [reservationHours, setReservationHours] = React.useState('72');
  const [discount, setDiscount] = React.useState('');
  const [charges, setCharges] = React.useState<{ name: string; amount: string }[]>([]);
  const [remarks, setRemarks] = React.useState('');
  const [brokerId, setBrokerId] = React.useState('');
  const brokers = useQuery({
    queryKey: ['brokers', 'options'],
    queryFn: () => api.get<{ id: string; name: string; commissionBp: number }[]>('/brokers'),
    enabled: can('brokers.read'),
  });
  const idempotencyKey = React.useRef(newIdempotencyKey());

  const preCustomer = params.get('customer');
  useQuery({
    queryKey: ['customer', preCustomer],
    queryFn: async () => {
      const c = await api.get<Customer>(`/customers/${preCustomer}`);
      setCustomer(c);
      return c;
    },
    enabled: Boolean(preCustomer) && !customer,
  });

  const debouncedCustomer = useDebounced(customerQuery, 250);
  const customers = useQuery({
    queryKey: ['customers', 'pick', debouncedCustomer],
    queryFn: () => api.page<Customer>('/customers', { q: debouncedCustomer, pageSize: 8 }),
    enabled: !customer && debouncedCustomer.length >= 2,
  });
  const plots = useQuery({
    queryKey: ['plots', projectId, 'available'],
    queryFn: () => api.page<Plot>(`/projects/${projectId}/plots`, { status: 'available', pageSize: 100, sort: 'plotNumber' }),
    enabled: Boolean(projectId),
  });
  const preselected = useQuery({
    queryKey: ['plots', projectId, 'preselected', plotIds],
    queryFn: () => Promise.all(plotIds.map((id) => api.get<Plot>(`/projects/${projectId}/plots/${id}`))),
    enabled: Boolean(projectId) && plotIds.length > 0,
  });
  const plans = useQuery({
    queryKey: ['payment-plans', projectId],
    queryFn: () => api.get<PaymentPlan[]>('/payment-plans', { projectId }),
    enabled: Boolean(projectId),
    select: (rows) => rows.filter((p) => p.isActive),
  });

  let discountPaise = 0;
  let chargeRows: { name: string; amountPaise: number }[] = [];
  let inputError: string | null = null;
  try {
    discountPaise = toPaise(discount);
    chargeRows = charges.filter((c) => c.name.trim() || c.amount).map((c) => ({ name: c.name.trim(), amountPaise: toPaise(c.amount) }));
    if (chargeRows.some((c) => !c.name)) inputError = 'Every charge needs a name';
  } catch {
    inputError = 'Check the discount and charge amounts';
  }
  const quoteInput =
    projectId && plotIds.length && planId && !inputError
      ? { projectId, plotIds, paymentPlanId: planId, bookingDate, discountPaise, charges: chargeRows }
      : null;
  const debouncedQuote = useDebounced(quoteInput, 300);
  const quote = useQuery({
    queryKey: ['quote', debouncedQuote],
    queryFn: () => api.post<Quote>('/bookings/quote', debouncedQuote),
    enabled: Boolean(debouncedQuote),
    retry: false,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<{ id: string; bookingNumber: string }>(
        '/bookings',
        {
          projectId,
          customerId: customer!.id,
          plotIds,
          paymentPlanId: planId,
          bookingDate,
          mode,
          reservationHours: mode === 'reserve' ? Number(reservationHours) : undefined,
          discountPaise,
          charges: chargeRows,
          remarks: remarks || undefined,
          brokerId: brokerId || undefined,
        },
        idempotencyKey.current,
      ),
    onSuccess: (b) => {
      qc.invalidateQueries({ queryKey: ['bookings'] });
      qc.invalidateQueries({ queryKey: ['plots', projectId] });
      qc.invalidateQueries({ queryKey: ['map', projectId] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(`Booking ${b.bookingNumber} created`);
      navigate(`/bookings/${b.id}`, { replace: true });
    },
    onError: (e) => {
      // A failed request releases the key server-side; use a fresh one for the next attempt.
      idempotencyKey.current = newIdempotencyKey();
      toast.error(errorMessage(e));
      qc.invalidateQueries({ queryKey: ['plots', projectId] });
    },
  });

  const availablePlots = plots.data?.items ?? [];
  const selectedPlots = plotIds
    .map((id) => availablePlots.find((p) => p.id === id) ?? preselected.data?.find((p) => p.id === id))
    .filter(Boolean) as Plot[];
  const filteredPlots = availablePlots.filter(
    (p) => !plotIds.includes(p.id) && `${p.blockCode ?? ''}-${p.plotNumber}`.toLowerCase().includes(plotFilter.toLowerCase()),
  );
  const ready = projectId && customer && plotIds.length && planId && quote.data && quote.data.unavailable.length === 0;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Bookings', to: '/bookings' }, { label: 'New booking' }]}
        title="New booking"
        description="Plots are held only when you submit; availability is re-checked at that moment."
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>1. Project & customer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Project" htmlFor="nb-project" required>
                <Select
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    setPlotIds([]);
                    setPlanId('');
                  }}
                >
                  <option value="">Choose…</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="nb-customer">
                  Customer<span className="ml-0.5 text-destructive">*</span>
                </Label>
                {customer ? (
                  <div className="flex h-9 items-center justify-between rounded-md border bg-muted/50 px-3 text-sm">
                    <span className="truncate">
                      {customer.name} · {customer.phone}
                    </span>
                    <button type="button" onClick={() => setCustomer(null)} aria-label="Change customer" className="cursor-pointer">
                      <X className="size-4" />
                    </button>
                  </div>
                ) : (
                  <div className="relative">
                    <Input
                      id="nb-customer"
                      value={customerQuery}
                      onChange={(e) => setCustomerQuery(e.target.value)}
                      placeholder="Search name or phone…"
                      autoComplete="off"
                    />
                    {customers.data && debouncedCustomer.length >= 2 && (
                      <div className="absolute z-20 mt-1 w-full rounded-lg border bg-popover p-1 shadow-lg">
                        {customers.data.items.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No match</p>}
                        {customers.data.items.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => setCustomer(c)}
                            className="flex w-full justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted cursor-pointer"
                          >
                            <span>{c.name}</span>
                            <span className="text-muted-foreground">{c.phone}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {!customer && can('customers.create') && (
                  <Button type="button" variant="link" size="sm" className="h-auto self-start p-0" onClick={() => setNewCustomer(true)}>
                    <UserPlus /> Add new customer
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Plots</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {!projectId ? (
                <p className="text-sm text-muted-foreground">Choose a project first.</p>
              ) : (
                <>
                  {selectedPlots.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {selectedPlots.map((p) => (
                        <span key={p.id} className="inline-flex items-center gap-1.5 rounded-full border bg-accent px-3 py-1 text-sm">
                          {p.blockCode ? `${p.blockCode}-` : ''}
                          {p.plotNumber} · {areaToSqft(p.areaX100)} sq ft
                          <button
                            type="button"
                            onClick={() => setPlotIds((ids) => ids.filter((x) => x !== p.id))}
                            aria-label={`Remove plot ${p.plotNumber}`}
                            className="cursor-pointer"
                          >
                            <X className="size-3.5" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <Input
                    value={plotFilter}
                    onChange={(e) => setPlotFilter(e.target.value)}
                    placeholder="Filter available plots…"
                    aria-label="Filter available plots"
                  />
                  <div className="grid max-h-64 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4 lg:grid-cols-6">
                    {filteredPlots.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPlotIds((ids) => [...ids, p.id])}
                        className="rounded-md border border-green-200 bg-green-50 px-2 py-2 text-left text-xs hover:border-green-500 dark:border-green-900 dark:bg-green-950/30 cursor-pointer"
                      >
                        <span className="block font-semibold">
                          {p.blockCode ? `${p.blockCode}-` : ''}
                          {p.plotNumber}
                        </span>
                        <span className="text-muted-foreground">{areaToSqft(p.areaX100)} sq ft</span>
                      </button>
                    ))}
                    {plots.data && filteredPlots.length === 0 && (
                      <p className="col-span-full text-sm text-muted-foreground">No more available plots.</p>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>3. Terms</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Payment plan" htmlFor="nb-plan" required>
                <Select value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={!projectId}>
                  <option value="">Choose…</option>
                  {plans.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Booking date" htmlFor="nb-date" required>
                <Input type="date" value={bookingDate} onChange={(e) => setBookingDate(e.target.value)} />
              </Field>
              <fieldset className="sm:col-span-2">
                <legend className="mb-2 text-sm font-medium">Type</legend>
                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="mode" checked={mode === 'book'} onChange={() => setMode('book')} /> Confirmed booking
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="mode" checked={mode === 'reserve'} onChange={() => setMode('reserve')} /> Temporary
                    reservation
                  </label>
                  {mode === 'reserve' && (
                    <label className="flex items-center gap-2 text-sm">
                      Hold for
                      <Input
                        className="h-8 w-20"
                        inputMode="numeric"
                        value={reservationHours}
                        onChange={(e) => setReservationHours(e.target.value)}
                        aria-label="Hold hours"
                      />
                      hours
                    </label>
                  )}
                </div>
              </fieldset>
              {can('bookings.discount') && (
                <Field label="Discount" htmlFor="nb-discount">
                  <MoneyInput value={discount} onChange={(e) => setDiscount(e.target.value)} />
                </Field>
              )}
              <div className="sm:col-span-2">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium">Additional charges</p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setCharges((c) => [...c, { name: '', amount: '' }])}
                    disabled={charges.length >= 10}
                  >
                    <Plus /> Add charge
                  </Button>
                </div>
                {charges.map((c, i) => (
                  <div key={i} className="mb-2 grid grid-cols-[1fr_160px_auto] gap-2">
                    <Input
                      value={c.name}
                      onChange={(e) => setCharges((cs) => cs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                      placeholder="e.g. Development charges"
                      aria-label="Charge name"
                    />
                    <MoneyInput
                      value={c.amount}
                      onChange={(e) => setCharges((cs) => cs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                      aria-label="Charge amount"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => setCharges((cs) => cs.filter((_, j) => j !== i))}
                      aria-label="Remove charge"
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
              </div>
              {can('brokers.read') && (
                <Field label="Broker" htmlFor="nb-broker" hint="Commission accrues when the booking is confirmed">
                  <Select value={brokerId} onChange={(e) => setBrokerId(e.target.value)}>
                    <option value="">Direct (no broker)</option>
                    {brokers.data?.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} · {b.commissionBp / 100}%
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Remarks" htmlFor="nb-remarks" className="sm:col-span-2">
                <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
              </Field>
            </CardContent>
          </Card>
        </div>

        <div className="xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Quotation</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {inputError && <p className="text-sm text-destructive">{inputError}</p>}
              {!quoteInput ? (
                <p className="text-sm text-muted-foreground">Select plots and a payment plan to see the price and schedule.</p>
              ) : quote.isError ? (
                <p className="text-sm text-destructive">{errorMessage(quote.error)}</p>
              ) : !quote.data ? (
                <p className="text-sm text-muted-foreground">Calculating…</p>
              ) : (
                <>
                  {quote.data.unavailable.length > 0 && (
                    <p className="rounded-md bg-red-50 p-2 text-sm text-red-800 dark:bg-red-950/30 dark:text-red-200">
                      No longer available: {quote.data.unavailable.map((u) => u.plotNumber).join(', ')}
                    </p>
                  )}
                  <table className="w-full text-sm">
                    <tbody>
                      {quote.data.items.map((i) => (
                        <tr key={i.plotId}>
                          <td className="py-1">
                            Plot {i.blockCode ? `${i.blockCode}-` : ''}
                            {i.plotNumber}
                            <span className="block text-xs text-muted-foreground">
                              {areaToSqft(i.areaX100)} sq ft × {formatINR(i.ratePaisePerSqft, { decimals: false })}
                              {i.plcPaise ? ` + PLC ${formatINR(i.plcPaise, { decimals: false })}` : ''}
                            </span>
                          </td>
                          <td className="py-1 text-right tabular">{formatINR(i.lineTotalPaise)}</td>
                        </tr>
                      ))}
                      {quote.data.discountPaise > 0 && (
                        <tr>
                          <td className="py-1">Discount</td>
                          <td className="py-1 text-right tabular">−{formatINR(quote.data.discountPaise)}</td>
                        </tr>
                      )}
                      {quote.data.chargesTotalPaise > 0 && (
                        <tr>
                          <td className="py-1">Charges</td>
                          <td className="py-1 text-right tabular">{formatINR(quote.data.chargesTotalPaise)}</td>
                        </tr>
                      )}
                      <tr className="border-t font-semibold">
                        <td className="pt-2">Total</td>
                        <td className="pt-2 text-right tabular">{formatINR(quote.data.netAmountPaise)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div>
                    <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Schedule · {quote.data.planName}
                    </p>
                    <ul className="max-h-56 space-y-1 overflow-y-auto text-sm">
                      {quote.data.schedule.map((s) => (
                        <li key={s.sequence} className="flex justify-between gap-2">
                          <span>
                            {s.name} <span className="text-muted-foreground">· {formatDate(s.dueDate)}</span>
                          </span>
                          <span className="tabular">{formatINR(s.amountPaise)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
              <Button className="w-full" disabled={!ready} loading={create.isPending} onClick={() => create.mutate()}>
                <BadgeCheck /> {mode === 'reserve' ? 'Reserve plots' : 'Create booking'}
              </Button>
              {!customer && <p className="text-center text-xs text-muted-foreground">Select a customer to continue.</p>}
            </CardContent>
          </Card>
        </div>
      </div>
      <CustomerFormSheet open={newCustomer} onOpenChange={setNewCustomer} onCreated={(c) => setCustomer(c)} />
    </>
  );
}

interface BookingDetail {
  id: string;
  bookingNumber: string;
  status: 'reserved' | 'booked' | 'cancelled' | 'expired';
  bookingDate: string;
  reservedUntil?: string;
  confirmedAt?: string;
  closedAt?: string;
  cancellation?: { reason: string; chargePaise: number };
  grossAmountPaise: number;
  discountPaise: number;
  charges: { name: string; amountPaise: number }[];
  netAmountPaise: number;
  remarks?: string;
  planSnapshot: { name: string };
  customerId: { id: string; name: string; phone: string; customerCode: string; email?: string };
  projectId: { id: string; name: string; code: string };
  brokerId?: { name: string; phone: string };
  items: {
    id: string;
    plotId: string;
    plotNumber: string;
    blockCode?: string;
    areaX100: number;
    ratePaisePerSqft: number;
    plcPaise: number;
    lineTotalPaise: number;
  }[];
  installments: {
    id: string;
    sequence: number;
    name: string;
    dueDate: string;
    amountPaise: number;
    paidPaise: number;
    balancePaise: number;
    status: string;
    overdue: boolean;
  }[];
  payments: {
    id: string;
    number: string;
    kind: 'receipt' | 'refund';
    amountPaise: number;
    mode: string;
    reference?: string;
    date: string;
    status: string;
  }[];
  summary: {
    netAmountPaise: number;
    receivedPaise: number;
    allocatedPaise: number;
    advancePaise: number;
    outstandingPaise: number;
    overduePaise: number;
    refundablePaise: number;
    refundedPaise: number;
  };
}

export function BookingDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [paying, setPaying] = React.useState(false);
  const [refunding, setRefunding] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const [cancelling, setCancelling] = React.useState(false);
  const [cancelReason, setCancelReason] = React.useState('');
  const [cancelCharge, setCancelCharge] = React.useState('');
  const [reversing, setReversing] = React.useState<string | null>(null);
  const [reverseReason, setReverseReason] = React.useState('');
  const q = useQuery({ queryKey: ['booking', id], queryFn: () => api.get<BookingDetail>(`/bookings/${id}`) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['booking', id] });
    qc.invalidateQueries({ queryKey: ['bookings'] });
    qc.invalidateQueries({ queryKey: ['plots'] });
    qc.invalidateQueries({ queryKey: ['map'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const confirm = useMutation({
    mutationFn: () => api.post(`/bookings/${id}/confirm`),
    onSuccess: () => {
      refresh();
      setConfirming(false);
      toast.success('Booking confirmed');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: () => api.post(`/bookings/${id}/cancel`, { reason: cancelReason, cancellationChargePaise: toPaise(cancelCharge || '0') }),
    onSuccess: () => {
      refresh();
      setCancelling(false);
      toast.success('Booking cancelled; plots released');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reverse = useMutation({
    mutationFn: (paymentId: string) => api.post(`/payments/${paymentId}/reverse`, { reason: reverseReason }),
    onSuccess: () => {
      refresh();
      setReversing(null);
      setReverseReason('');
      toast.success('Receipt reversed');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const b = q.data;
  const active = b.status === 'reserved' || b.status === 'booked';
  const s = b.summary;

  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Bookings', to: '/bookings' }, { label: b.bookingNumber }]}
        title={
          <span className="flex items-center gap-3">
            {b.bookingNumber} <StatusBadge status={b.status} kind="booking" />
          </span>
        }
        description={
          <>
            <Link className="hover:underline" to={`/customers/${b.customerId.id}`}>
              {b.customerId.name}
            </Link>{' '}
            · {b.projectId.name} · booked on {formatDate(b.bookingDate.slice(0, 10))}
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              onClick={() => void download(`/bookings/${b.id}/allotment.pdf`, undefined, 'open').catch((e) => toast.error(errorMessage(e)))}
            >
              <FileText /> {b.status === 'reserved' ? 'Reservation letter' : 'Allotment letter'}
            </Button>
            {active && can('payments.create') && (
              <Button onClick={() => setPaying(true)}>
                <IndianRupee /> Record payment
              </Button>
            )}
            {b.status === 'reserved' && can('bookings.confirm') && (
              <Button variant="outline" onClick={() => setConfirming(true)}>
                <BadgeCheck /> Confirm
              </Button>
            )}
            {active && can('bookings.cancel') && (
              <Button variant="ghost" className="text-destructive" onClick={() => setCancelling(true)}>
                <Ban /> Cancel
              </Button>
            )}
            {!active && s.refundablePaise > 0 && can('payments.refund') && (
              <Button onClick={() => setRefunding(true)}>
                <Undo2 /> Pay refund
              </Button>
            )}
          </>
        }
      />

      {b.status === 'reserved' && b.reservedUntil && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          Reservation held until {formatDateTime(b.reservedUntil)}. It expires automatically unless confirmed.
        </div>
      )}
      {b.cancellation?.reason && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">
          {titleCase(b.status)} on {b.closedAt ? formatDateTime(b.closedAt) : ''}: {b.cancellation.reason}
          {b.cancellation.chargePaise ? ` · cancellation charges ${formatINR(b.cancellation.chargePaise)}` : ''}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total consideration" value={formatINR(s.netAmountPaise, { decimals: false })} />
        <StatCard
          label="Received"
          value={formatINR(s.receivedPaise, { decimals: false })}
          hint={s.advancePaise ? `${formatINR(s.advancePaise)} held as advance` : undefined}
          tone="success"
        />
        {active ? (
          <>
            <StatCard label="Outstanding" value={formatINR(s.outstandingPaise, { decimals: false })} />
            <StatCard label="Overdue" value={formatINR(s.overduePaise, { decimals: false })} tone={s.overduePaise ? 'danger' : 'default'} />
          </>
        ) : (
          <>
            <StatCard label="Refundable" value={formatINR(s.refundablePaise, { decimals: false })} tone="warning" />
            <StatCard label="Refunded" value={formatINR(s.refundedPaise, { decimals: false })} />
          </>
        )}
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Installment schedule</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Installment</th>
                  <th className="py-2 pr-2">Due</th>
                  <th className="py-2 pr-2 text-right">Amount</th>
                  <th className="py-2 pr-2 text-right">Paid</th>
                  <th className="py-2 pr-2 text-right">Balance</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {b.installments.map((i) => (
                  <tr key={i.id} className="border-b last:border-0">
                    <td className="py-2 pr-2 text-muted-foreground">{i.sequence}</td>
                    <td className="py-2 pr-2">{i.name}</td>
                    <td className="py-2 pr-2 whitespace-nowrap">{formatDate(i.dueDate.slice(0, 10))}</td>
                    <td className="py-2 pr-2 text-right tabular">{formatINR(i.amountPaise)}</td>
                    <td className="py-2 pr-2 text-right tabular">{formatINR(i.paidPaise)}</td>
                    <td className="py-2 pr-2 text-right tabular">{formatINR(i.balancePaise)}</td>
                    <td className="py-2">
                      <StatusBadge status={i.overdue ? 'overdue' : i.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Plots</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y text-sm">
                {b.items.map((i) => (
                  <li key={i.id} className="flex justify-between gap-2 py-2">
                    <span>
                      <Link to={`/inventory?project=${b.projectId.id}&plot=${i.plotId}`} className="font-medium hover:underline">
                        Plot {i.blockCode ? `${i.blockCode}-` : ''}
                        {i.plotNumber}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {areaToSqft(i.areaX100)} sq ft @ {formatINR(i.ratePaisePerSqft, { decimals: false })}
                      </span>
                    </span>
                    <span className="tabular">{formatINR(i.lineTotalPaise, { decimals: false })}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 space-y-1 border-t pt-3 text-sm">
                <div className="flex justify-between">
                  <span>Plot value</span>
                  <span className="tabular">{formatINR(b.grossAmountPaise)}</span>
                </div>
                {b.discountPaise > 0 && (
                  <div className="flex justify-between">
                    <span>Discount</span>
                    <span className="tabular">−{formatINR(b.discountPaise)}</span>
                  </div>
                )}
                {b.charges.map((c) => (
                  <div key={c.name} className="flex justify-between">
                    <span>{c.name}</span>
                    <span className="tabular">{formatINR(c.amountPaise)}</span>
                  </div>
                ))}
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span className="tabular">{formatINR(b.netAmountPaise)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-5">
              <DescriptionList
                className="sm:grid-cols-1"
                items={[
                  { label: 'Customer', value: `${b.customerId.name} (${b.customerId.customerCode}) · ${b.customerId.phone}` },
                  { label: 'Payment plan', value: b.planSnapshot.name },
                  { label: 'Broker', value: b.brokerId ? `${b.brokerId.name} · ${b.brokerId.phone}` : '—' },
                  { label: 'Remarks', value: b.remarks },
                ]}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Receipts & refunds</CardTitle>
        </CardHeader>
        <CardContent>
          {b.payments.length === 0 ? (
            <EmptyState icon={ReceiptIndianRupee} title="No payments yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-2">Number</th>
                    <th className="py-2 pr-2">Date</th>
                    <th className="py-2 pr-2">Mode</th>
                    <th className="py-2 pr-2 text-right">Amount</th>
                    <th className="py-2 pr-2">Status</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {b.payments.map((p) => (
                    <tr key={p.id} className="border-b last:border-0">
                      <td className="py-2 pr-2">
                        <Link to={`/payments/${p.id}`} className="font-medium hover:underline">
                          {p.number}
                        </Link>
                        {p.kind === 'refund' && <span className="ml-2 text-xs text-muted-foreground">refund</span>}
                      </td>
                      <td className="py-2 pr-2">{formatDate(p.date.slice(0, 10))}</td>
                      <td className="py-2 pr-2">
                        {p.mode.toUpperCase()}
                        {p.reference ? ` · ${p.reference}` : ''}
                      </td>
                      <td className="py-2 pr-2 text-right tabular">
                        {p.kind === 'refund' ? '−' : ''}
                        {formatINR(p.amountPaise)}
                      </td>
                      <td className="py-2 pr-2">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="py-2 text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              void download(`/payments/${p.id}/receipt.pdf`, undefined, 'open').catch((e) => toast.error(errorMessage(e)))
                            }
                          >
                            <FileText /> PDF
                          </Button>
                          {p.kind === 'receipt' && p.status === 'received' && active && can('payments.reverse') && (
                            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setReversing(p.id)}>
                              Reverse
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="mt-6">
        <DocumentsPanel entityType="booking" entityId={b.id} title="Agreements & booking documents" />
      </div>

      {active && (
        <RecordPaymentDialog
          open={paying}
          onOpenChange={setPaying}
          booking={{ id: b.id, bookingNumber: b.bookingNumber, outstandingPaise: s.outstandingPaise }}
          canSeeAccounts={can('accounting.read')}
        />
      )}
      {!active && (
        <RefundDialog
          open={refunding}
          onOpenChange={setRefunding}
          booking={{ id: b.id, bookingNumber: b.bookingNumber, refundablePaise: s.refundablePaise }}
        />
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Confirm this reservation?"
        description="The plots move from reserved to booked and the hold timer is removed."
        confirmLabel="Confirm booking"
        loading={confirm.isPending}
        onConfirm={() => confirm.mutate()}
      />
      <ConfirmDialog
        open={cancelling}
        onOpenChange={setCancelling}
        title="Cancel this booking?"
        description={
          <>
            Plots are released for sale, open installments are cancelled and the sale is reversed in the books. {formatINR(s.receivedPaise)}{' '}
            received will move to refunds payable, less any cancellation charge.
          </>
        }
        confirmLabel="Cancel booking"
        destructive
        loading={cancel.isPending}
        onConfirm={() => (cancelReason.trim() ? cancel.mutate() : toast.error('Please enter a reason'))}
      >
        <div className="grid gap-3">
          <Field label="Reason" htmlFor="cx-reason" required>
            <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </Field>
          {s.receivedPaise > 0 && (
            <Field label="Cancellation charges retained" htmlFor="cx-charge" hint={`Up to ${formatINR(s.receivedPaise)}`}>
              <MoneyInput value={cancelCharge} onChange={(e) => setCancelCharge(e.target.value)} />
            </Field>
          )}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={!!reversing}
        onOpenChange={(o) => !o && setReversing(null)}
        title="Reverse this receipt?"
        description="Use this for bounced cheques or entries made in error. Installment balances are restored and a reversal voucher is posted."
        confirmLabel="Reverse receipt"
        destructive
        loading={reverse.isPending}
        onConfirm={() => (reverseReason.trim() ? reverse.mutate(reversing!) : toast.error('Please enter a reason'))}
      >
        <Field label="Reason" htmlFor="rv-reason" required>
          <Input value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} placeholder="e.g. Cheque bounced" />
        </Field>
      </ConfirmDialog>
    </>
  );
}
