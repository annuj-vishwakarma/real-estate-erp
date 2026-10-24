import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BookOpenCheck, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { formatDate, formatINR } from '@/lib/format';
import { useListParams } from '@/hooks/use-list-params';
import { Can, useAuth } from '@/features/auth/auth-context';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui/primitives';
import { Sheet, SheetContent } from '@/components/ui/overlays';
import { DataTable, type Column } from '@/components/data-table';
import { DescriptionList, Field, PageHeader, StatusBadge } from '@/components/common';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { SearchInput } from '@/components/search-input';
import { DocumentsPanel } from '@/components/documents-panel';

export interface Customer {
  id: string;
  customerCode: string;
  name: string;
  phone: string;
  altPhone?: string;
  email?: string;
  pan?: string;
  aadhaarLast4?: string;
  dateOfBirth?: string;
  occupation?: string;
  address?: { line1?: string; line2?: string; city?: string; state?: string; pincode?: string };
  coApplicants: { name: string; relation?: string; phone?: string; email?: string; pan?: string }[];
  notes?: string;
  createdAt: string;
  bookings?: {
    id: string;
    bookingNumber: string;
    status: string;
    netAmountPaise: number;
    allocatedPaise: number;
    bookingDate: string;
    projectId?: { name: string; code: string };
  }[];
}

const opt = (re: RegExp, msg: string) => z.string().trim().regex(re, msg).or(z.literal('')).optional();
const customerForm = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9\s-]{6,16}$/, 'Enter a valid phone number'),
  altPhone: opt(/^\+?[0-9][0-9\s-]{6,16}$/, 'Enter a valid phone number'),
  email: z.string().trim().email('Enter a valid email').or(z.literal('')).optional(),
  pan: opt(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, 'Enter a valid PAN'),
  aadhaarLast4: opt(/^\d{4}$/, 'Last 4 digits only'),
  dateOfBirth: z.string().optional(),
  occupation: z.string().max(100).optional(),
  line1: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  pincode: opt(/^[1-9][0-9]{5}$/, '6-digit PIN'),
  notes: z.string().max(1000).optional(),
  coApplicants: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Name is required').max(120),
        relation: z.string().max(60).optional(),
        phone: opt(/^\+?[0-9][0-9\s-]{6,16}$/, 'Invalid phone'),
        pan: opt(/^[A-Za-z]{5}[0-9]{4}[A-Za-z]$/, 'Invalid PAN'),
      }),
    )
    .max(5),
});
type CustomerForm = z.infer<typeof customerForm>;
const blank = (v?: string) => (v ? v : undefined);

export function CustomerFormSheet({
  open,
  onOpenChange,
  customer,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  customer?: Customer;
  onCreated?: (c: Customer) => void;
}) {
  const qc = useQueryClient();
  const form = useForm<CustomerForm>({
    resolver: zodResolver(customerForm),
    values: {
      name: customer?.name ?? '',
      phone: customer?.phone ?? '',
      altPhone: customer?.altPhone ?? '',
      email: customer?.email ?? '',
      pan: customer?.pan ?? '',
      aadhaarLast4: customer?.aadhaarLast4 ?? '',
      dateOfBirth: customer?.dateOfBirth?.slice(0, 10) ?? '',
      occupation: customer?.occupation ?? '',
      line1: customer?.address?.line1 ?? '',
      city: customer?.address?.city ?? '',
      state: customer?.address?.state ?? '',
      pincode: customer?.address?.pincode ?? '',
      notes: customer?.notes ?? '',
      coApplicants:
        customer?.coApplicants?.map((c) => ({ name: c.name, relation: c.relation ?? '', phone: c.phone ?? '', pan: c.pan ?? '' })) ?? [],
    },
  });
  const co = useFieldArray({ control: form.control, name: 'coApplicants' });
  const save = useMutation({
    mutationFn: (v: CustomerForm) => {
      const payload = {
        name: v.name,
        phone: v.phone,
        altPhone: blank(v.altPhone),
        email: blank(v.email),
        pan: blank(v.pan?.toUpperCase()),
        aadhaarLast4: blank(v.aadhaarLast4),
        dateOfBirth: blank(v.dateOfBirth),
        occupation: blank(v.occupation),
        address: { line1: blank(v.line1), city: blank(v.city), state: blank(v.state), pincode: blank(v.pincode) },
        notes: blank(v.notes),
        coApplicants: v.coApplicants.map((c) => ({
          name: c.name,
          relation: blank(c.relation),
          phone: blank(c.phone),
          pan: blank(c.pan?.toUpperCase()),
        })),
      };
      return customer ? api.patch<Customer>(`/customers/${customer.id}`, payload) : api.post<Customer>('/customers', payload);
    },
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['customers'] });
      qc.invalidateQueries({ queryKey: ['customer', c.id] });
      toast.success(customer ? 'Customer updated' : 'Customer added');
      onOpenChange(false);
      onCreated?.(c);
    },
    onError: (err) => {
      const f = fieldErrors(err);
      Object.entries(f).forEach(([k, m]) => form.setError(k as keyof CustomerForm, { message: m }));
      if (!Object.keys(f).length) toast.error(errorMessage(err));
    },
  });
  const e = form.formState.errors;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        title={customer ? `Edit ${customer.name}` : 'New customer'}
        footer={
          <>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="customer-form" loading={save.isPending}>
              Save
            </Button>
          </>
        }
      >
        <form id="customer-form" className="grid gap-4 sm:grid-cols-2" onSubmit={form.handleSubmit((v) => save.mutate(v))} noValidate>
          <Field label="Full name" htmlFor="c-name" error={e.name?.message} required className="sm:col-span-2">
            <Input autoComplete="off" {...form.register('name')} />
          </Field>
          <Field label="Mobile" htmlFor="c-phone" error={e.phone?.message} required>
            <Input type="tel" {...form.register('phone')} />
          </Field>
          <Field label="Alternate phone" htmlFor="c-alt" error={e.altPhone?.message}>
            <Input type="tel" {...form.register('altPhone')} />
          </Field>
          <Field label="Email" htmlFor="c-email" error={e.email?.message}>
            <Input type="email" {...form.register('email')} />
          </Field>
          <Field label="PAN" htmlFor="c-pan" error={e.pan?.message}>
            <Input className="uppercase" {...form.register('pan')} />
          </Field>
          <Field
            label="Aadhaar (last 4 digits)"
            htmlFor="c-aadhaar"
            error={e.aadhaarLast4?.message}
            hint="Full Aadhaar numbers are never stored"
          >
            <Input inputMode="numeric" maxLength={4} {...form.register('aadhaarLast4')} />
          </Field>
          <Field label="Date of birth" htmlFor="c-dob">
            <Input type="date" {...form.register('dateOfBirth')} />
          </Field>
          <Field label="Occupation" htmlFor="c-occ">
            <Input {...form.register('occupation')} />
          </Field>
          <Field label="Address" htmlFor="c-line1" className="sm:col-span-2">
            <Input {...form.register('line1')} />
          </Field>
          <Field label="City" htmlFor="c-city">
            <Input {...form.register('city')} />
          </Field>
          <Field label="State" htmlFor="c-state">
            <Input {...form.register('state')} />
          </Field>
          <Field label="PIN code" htmlFor="c-pin" error={e.pincode?.message}>
            <Input inputMode="numeric" {...form.register('pincode')} />
          </Field>
          <div className="sm:col-span-2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-medium">Co-applicants</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={co.fields.length >= 5}
                onClick={() => co.append({ name: '', relation: '', phone: '', pan: '' })}
              >
                <Plus /> Add
              </Button>
            </div>
            {co.fields.length === 0 && <p className="text-sm text-muted-foreground">None</p>}
            <div className="space-y-3">
              {co.fields.map((f, i) => (
                <div key={f.id} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_auto]">
                  <Field label="Name" htmlFor={`co-${i}-name`} error={e.coApplicants?.[i]?.name?.message}>
                    <Input {...form.register(`coApplicants.${i}.name`)} />
                  </Field>
                  <Field label="Relation" htmlFor={`co-${i}-rel`}>
                    <Input {...form.register(`coApplicants.${i}.relation`)} />
                  </Field>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="self-end"
                    onClick={() => co.remove(i)}
                    aria-label="Remove co-applicant"
                  >
                    <Trash2 />
                  </Button>
                  <Field label="Phone" htmlFor={`co-${i}-phone`} error={e.coApplicants?.[i]?.phone?.message}>
                    <Input {...form.register(`coApplicants.${i}.phone`)} />
                  </Field>
                  <Field label="PAN" htmlFor={`co-${i}-pan`} error={e.coApplicants?.[i]?.pan?.message}>
                    <Input className="uppercase" {...form.register(`coApplicants.${i}.pan`)} />
                  </Field>
                </div>
              ))}
            </div>
          </div>
          <Field label="Notes" htmlFor="c-notes" className="sm:col-span-2">
            <Textarea rows={3} {...form.register('notes')} />
          </Field>
        </form>
      </SheetContent>
    </Sheet>
  );
}

export function CustomersPage() {
  const lp = useListParams();
  const navigate = useNavigate();
  const [creating, setCreating] = React.useState(false);
  const q = useQuery({
    queryKey: ['customers', lp.query],
    queryFn: () => api.page<Customer>('/customers', lp.query),
    placeholderData: (p) => p,
  });
  const columns: Column<Customer>[] = [
    { key: 'code', header: 'Code', sortKey: 'customerCode', cell: (c) => <span className="text-muted-foreground">{c.customerCode}</span> },
    { key: 'name', header: 'Name', sortKey: 'name', cell: (c) => <span className="font-medium">{c.name}</span> },
    { key: 'phone', header: 'Phone', cell: (c) => c.phone },
    { key: 'email', header: 'Email', cell: (c) => c.email ?? '—', hideOnMobile: true },
    { key: 'city', header: 'City', cell: (c) => c.address?.city ?? '—', hideOnMobile: true },
    { key: 'created', header: 'Added', sortKey: 'createdAt', cell: (c) => formatDate(c.createdAt), hideOnMobile: true },
  ];
  return (
    <>
      <PageHeader
        title="Customers"
        description="Buyers and co-applicants"
        actions={
          <Can permission="customers.create">
            <Button onClick={() => setCreating(true)}>
              <UserPlus /> New customer
            </Button>
          </Can>
        }
      />
      <div className="mb-4">
        <SearchInput value={lp.q} onChange={lp.setQ} placeholder="Name, phone, code or email" />
      </div>
      <DataTable
        columns={columns}
        rows={q.data?.items}
        rowKey={(c) => c.id}
        loading={q.isPending}
        error={q.error}
        onRetry={() => q.refetch()}
        meta={q.data?.meta}
        onPageChange={lp.setPage}
        pageSize={lp.pageSize}
        onPageSizeChange={lp.setPageSize}
        sort={lp.sort}
        onSortChange={lp.setSort}
        onRowClick={(c) => navigate(`/customers/${c.id}`)}
        empty={<EmptyState title="No customers found" />}
      />
      <CustomerFormSheet open={creating} onOpenChange={setCreating} onCreated={(c) => navigate(`/customers/${c.id}`)} />
    </>
  );
}

interface Ledger {
  entries: {
    id: string;
    entryNumber: string;
    date: string;
    narration: string;
    voucherType: string;
    debitPaise: number;
    creditPaise: number;
    balancePaise: number;
  }[];
  totals: { debitPaise: number; creditPaise: number; balancePaise: number };
}

function CustomerLedger({ customerId }: { customerId: string }) {
  const q = useQuery({ queryKey: ['customer', customerId, 'ledger'], queryFn: () => api.get<Ledger>(`/customers/${customerId}/ledger`) });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { entries, totals } = q.data;
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>Customer ledger</CardTitle>
        <span className={`text-sm font-semibold tabular ${totals.balancePaise > 0 ? 'text-destructive' : ''}`}>
          Balance {formatINR(Math.abs(totals.balancePaise))}{' '}
          {totals.balancePaise > 0 ? 'receivable' : totals.balancePaise < 0 ? 'payable to customer' : ''}
        </span>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <EmptyState title="No transactions yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 pr-3">Voucher</th>
                  <th className="py-2 pr-3">Particulars</th>
                  <th className="py-2 pr-3 text-right">Debit</th>
                  <th className="py-2 pr-3 text-right">Credit</th>
                  <th className="py-2 text-right">Balance</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={`${e.id}-${i}`} className="border-b last:border-0">
                    <td className="py-2 pr-3 whitespace-nowrap">{formatDate(e.date.slice(0, 10))}</td>
                    <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">{e.entryNumber}</td>
                    <td className="py-2 pr-3">{e.narration}</td>
                    <td className="py-2 pr-3 text-right tabular">{e.debitPaise ? formatINR(e.debitPaise) : ''}</td>
                    <td className="py-2 pr-3 text-right tabular">{e.creditPaise ? formatINR(e.creditPaise) : ''}</td>
                    <td className="py-2 text-right tabular">
                      {formatINR(Math.abs(e.balancePaise))} {e.balancePaise > 0 ? 'Dr' : e.balancePaise < 0 ? 'Cr' : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <td colSpan={3} className="py-2">
                    Total
                  </td>
                  <td className="py-2 pr-3 text-right tabular">{formatINR(totals.debitPaise)}</td>
                  <td className="py-2 pr-3 text-right tabular">{formatINR(totals.creditPaise)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CustomerDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [editing, setEditing] = React.useState(false);
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => api.get<Customer>(`/customers/${id}`) });
  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  return (
    <>
      <PageHeader
        breadcrumbs={[{ label: 'Customers', to: '/customers' }, { label: c.name }]}
        title={c.name}
        description={`${c.customerCode} · ${c.phone}`}
        actions={
          <>
            <Can permission="customers.update">
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            </Can>
            <Can permission="bookings.create">
              <Button onClick={() => navigate(`/bookings/new?customer=${c.id}`)}>
                <BookOpenCheck /> New booking
              </Button>
            </Can>
          </>
        }
      />
      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="bookings">Bookings ({c.bookings?.length ?? 0})</TabsTrigger>
          {can('payments.read') && <TabsTrigger value="ledger">Ledger</TabsTrigger>}
          <TabsTrigger value="documents">KYC & documents</TabsTrigger>
        </TabsList>
        <TabsContent value="profile">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardContent className="pt-5">
                <DescriptionList
                  items={[
                    { label: 'Mobile', value: c.phone },
                    { label: 'Alternate phone', value: c.altPhone },
                    { label: 'Email', value: c.email },
                    { label: 'PAN', value: c.pan },
                    { label: 'Aadhaar', value: c.aadhaarLast4 ? `XXXX XXXX ${c.aadhaarLast4}` : undefined },
                    { label: 'Date of birth', value: c.dateOfBirth ? formatDate(c.dateOfBirth.slice(0, 10)) : undefined },
                    { label: 'Occupation', value: c.occupation },
                    {
                      label: 'Address',
                      value:
                        [c.address?.line1, c.address?.city, c.address?.state, c.address?.pincode].filter(Boolean).join(', ') || undefined,
                    },
                  ]}
                />
                {c.notes && <p className="mt-4 whitespace-pre-line text-sm text-muted-foreground">{c.notes}</p>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Co-applicants</CardTitle>
              </CardHeader>
              <CardContent>
                {c.coApplicants.length === 0 ? (
                  <p className="text-sm text-muted-foreground">None</p>
                ) : (
                  <ul className="space-y-3">
                    {c.coApplicants.map((a, i) => (
                      <li key={i} className="text-sm">
                        <p className="font-medium">{a.name}</p>
                        <p className="text-muted-foreground">{[a.relation, a.phone, a.pan].filter(Boolean).join(' · ')}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="bookings">
          <Card>
            {c.bookings?.length ? (
              <ul className="divide-y">
                {c.bookings.map((b) => (
                  <li key={b.id}>
                    <Link to={`/bookings/${b.id}`} className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-muted/50">
                      <div>
                        <p className="font-medium">{b.bookingNumber}</p>
                        <p className="text-xs text-muted-foreground">
                          {b.projectId?.name} · {formatDate(b.bookingDate.slice(0, 10))}
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-sm">
                        <span className="tabular">
                          {formatINR(b.allocatedPaise, { decimals: false })} / {formatINR(b.netAmountPaise, { decimals: false })}
                        </span>
                        <StatusBadge status={b.status} kind="booking" />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No bookings yet" />
            )}
          </Card>
        </TabsContent>
        {can('payments.read') && (
          <TabsContent value="ledger">
            <CustomerLedger customerId={c.id} />
          </TabsContent>
        )}
        <TabsContent value="documents">
          <DocumentsPanel entityType="customer" entityId={c.id} title="KYC & documents" />
        </TabsContent>
      </Tabs>
      <CustomerFormSheet open={editing} onOpenChange={setEditing} customer={c} />
    </>
  );
}
