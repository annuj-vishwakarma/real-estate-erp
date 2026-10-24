import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle, Grid3x3, HardHat, IndianRupee, MapPinned, ReceiptIndianRupee, Target, TrendingUp, Wallet } from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PlotStatus } from '@erp/shared';
import { api } from '@/lib/api';
import { formatDate, formatINR, formatINRCompact, monthLabel } from '@/lib/format';
import { useProjectContext } from '@/hooks/use-project';
import { useAuth } from '@/features/auth/auth-context';
import { PageHeader, PLOT_STATUS_META, StatCard, StatusBadge } from '@/components/common';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/states';
import { Button } from '@/components/ui/button';

interface Dashboard {
  asOf: string;
  months: string[];
  inventory?: {
    byStatus: Partial<Record<PlotStatus, { count: number; valuePaise: number }>>;
    totalPlots: number;
    availableValuePaise: number;
  };
  sales?: {
    monthCount: number;
    monthValuePaise: number;
    fyCount: number;
    fyValuePaise: number;
    outstandingPaise: number;
    trend: { month: string; count: number; valuePaise: number }[];
    recent: {
      id: string;
      bookingNumber: string;
      status: string;
      netAmountPaise: number;
      bookingDate: string;
      customerId?: { name: string };
    }[];
  };
  collections?: {
    monthPaise: number;
    fyPaise: number;
    overduePaise: number;
    overdueCount: number;
    trend: { month: string; valuePaise: number }[];
    upcoming: {
      id: string;
      name: string;
      dueDate: string;
      amountPaise: number;
      paidPaise: number;
      customerId?: { name: string };
      bookingId?: { id: string; bookingNumber: string };
    }[];
  };
  expenses?: { monthPaise: number; trend: { month: string; valuePaise: number }[] };
  operations?: {
    leads?: { open: number; followUpsDue: number; wonThisMonth: number };
    land?: { parcels: number; agreedCostPaise: number; paidPaise: number };
    construction?: { openWorkOrders: number; committedPaise: number; billedPaise: number };
  };
}

const axisRupees = (v: number) => formatINRCompact(v).replace('₹', '');

export function DashboardPage() {
  const { projectId, project } = useProjectContext();
  const { context } = useAuth();
  const q = useQuery({
    queryKey: ['dashboard', projectId],
    queryFn: () => api.get<Dashboard>('/dashboard', { projectId: projectId ?? undefined }),
  });

  if (q.isPending) return <PageSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;

  const statusData = d.inventory
    ? (Object.keys(PLOT_STATUS_META) as PlotStatus[]).map((s) => ({
        name: PLOT_STATUS_META[s].label,
        value: d.inventory!.byStatus[s]?.count ?? 0,
        color: PLOT_STATUS_META[s].color,
      }))
    : [];
  const trend = d.months.map((m, i) => ({
    month: monthLabel(m),
    sales: d.sales?.trend[i]?.valuePaise ?? 0,
    collections: d.collections?.trend[i]?.valuePaise ?? 0,
    expenses: d.expenses?.trend[i]?.valuePaise ?? 0,
  }));
  const noData = d.inventory?.totalPlots === 0 && !d.sales?.fyCount;

  return (
    <>
      <PageHeader
        title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${context?.user.name.split(' ')[0]}`}
        description={`${project ? project.name : 'All projects'} · as of ${formatDate(d.asOf)}`}
      />

      {noData && (
        <Card className="mb-6">
          <EmptyState
            title="Let’s set up your first project"
            description="Create a project, add plots in bulk and draw them on the layout map. Bookings and collections will appear here automatically."
            action={
              <Button asChild>
                <Link to="/projects">Go to projects</Link>
              </Button>
            }
          />
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {d.sales && (
          <StatCard
            label="Sales this month"
            value={formatINRCompact(d.sales.monthValuePaise)}
            hint={`${d.sales.monthCount} bookings · FY ${formatINRCompact(d.sales.fyValuePaise)}`}
            icon={TrendingUp}
          />
        )}
        {d.collections && (
          <StatCard
            label="Collections this month"
            value={formatINRCompact(d.collections.monthPaise)}
            hint={`FY to date ${formatINRCompact(d.collections.fyPaise)}`}
            icon={ReceiptIndianRupee}
            tone="success"
          />
        )}
        {d.collections && (
          <StatCard
            label="Overdue dues"
            value={formatINRCompact(d.collections.overduePaise)}
            hint={`${d.collections.overdueCount} installment${d.collections.overdueCount === 1 ? '' : 's'} past due`}
            icon={AlertTriangle}
            tone={d.collections.overduePaise > 0 ? 'danger' : 'default'}
          />
        )}
        {d.inventory && (
          <StatCard
            label="Available inventory"
            value={`${d.inventory.byStatus.available?.count ?? 0} / ${d.inventory.totalPlots} plots`}
            hint={`Worth ${formatINRCompact(d.inventory.availableValuePaise)}`}
            icon={Grid3x3}
            tone="warning"
          />
        )}
        {d.sales && (
          <StatCard
            label="Outstanding receivable"
            value={formatINRCompact(d.sales.outstandingPaise)}
            hint="Across active bookings"
            icon={Wallet}
          />
        )}
        {d.expenses && (
          <StatCard
            label="Expenses this month"
            value={formatINRCompact(d.expenses.monthPaise)}
            hint="Posted to expense accounts"
            icon={IndianRupee}
          />
        )}
      </div>

      {d.operations && (
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {d.operations.leads && (
            <Link to="/crm?view=list&followUp=due" className="rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
              <StatCard
                label="Leads"
                value={`${d.operations.leads.open} open`}
                hint={`${d.operations.leads.followUpsDue} follow-ups due · ${d.operations.leads.wonThisMonth} won this month`}
                icon={Target}
                tone={d.operations.leads.followUpsDue ? 'danger' : 'default'}
              />
            </Link>
          )}
          {d.operations.land && (
            <Link to="/land" className="rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
              <StatCard
                label="Land acquisition"
                value={formatINRCompact(d.operations.land.paidPaise)}
                hint={`paid of ${formatINRCompact(d.operations.land.agreedCostPaise)} agreed · ${d.operations.land.parcels} parcels`}
                icon={MapPinned}
              />
            </Link>
          )}
          {d.operations.construction && (
            <Link to="/work-orders" className="rounded-xl focus-visible:outline-2 focus-visible:outline-ring">
              <StatCard
                label="Development works"
                value={formatINRCompact(d.operations.construction.billedPaise)}
                hint={`billed of ${formatINRCompact(d.operations.construction.committedPaise)} committed · ${d.operations.construction.openWorkOrders} open orders`}
                icon={HardHat}
                tone="warning"
              />
            </Link>
          )}
        </div>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Sales vs collections</CardTitle>
            <CardDescription>Last 12 months</CardDescription>
          </CardHeader>
          <CardContent className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend} margin={{ left: 0, right: 8, top: 8 }}>
                <defs>
                  <linearGradient id="gSales" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gColl" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} />
                <YAxis
                  tickFormatter={axisRupees}
                  tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                  tickLine={false}
                  axisLine={false}
                  width={56}
                />
                <Tooltip
                  formatter={(v) => formatINR(Number(v))}
                  contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8 }}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                {d.sales && (
                  <Area type="monotone" dataKey="sales" name="Sales" stroke="var(--chart-1)" fill="url(#gSales)" strokeWidth={2} />
                )}
                {d.collections && (
                  <Area
                    type="monotone"
                    dataKey="collections"
                    name="Collections"
                    stroke="var(--chart-2)"
                    fill="url(#gColl)"
                    strokeWidth={2}
                  />
                )}
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {d.inventory && (
          <Card>
            <CardHeader>
              <CardTitle>Inventory status</CardTitle>
              <CardDescription>{d.inventory.totalPlots} plots</CardDescription>
            </CardHeader>
            <CardContent className="h-72">
              {d.inventory.totalPlots === 0 ? (
                <EmptyState title="No plots yet" />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" innerRadius={60} outerRadius={95} paddingAngle={2}>
                      {statusData.map((s) => (
                        <Cell key={s.name} fill={s.color} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {d.collections && (
          <Card>
            <CardHeader>
              <CardTitle>Upcoming dues</CardTitle>
              <CardDescription>Next 30 days</CardDescription>
            </CardHeader>
            <CardContent>
              {d.collections.upcoming.length === 0 ? (
                <EmptyState title="Nothing due in the next 30 days" />
              ) : (
                <ul className="divide-y">
                  {d.collections.upcoming.map((i) => (
                    <li key={i.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <Link to={`/bookings/${i.bookingId?.id}`} className="block truncate text-sm font-medium hover:underline">
                          {i.customerId?.name} · {i.bookingId?.bookingNumber}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {i.name} · due {formatDate(i.dueDate.slice(0, 10))}
                        </p>
                      </div>
                      <span className="shrink-0 text-sm font-medium tabular">{formatINR(i.amountPaise - i.paidPaise)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
        {d.sales && (
          <Card>
            <CardHeader>
              <CardTitle>Recent bookings</CardTitle>
            </CardHeader>
            <CardContent>
              {d.sales.recent.length === 0 ? (
                <EmptyState title="No bookings yet" />
              ) : (
                <ul className="divide-y">
                  {d.sales.recent.map((b) => (
                    <li key={b.id} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <Link to={`/bookings/${b.id}`} className="block truncate text-sm font-medium hover:underline">
                          {b.bookingNumber}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {b.customerId?.name} · {formatDate(b.bookingDate.slice(0, 10))}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-sm tabular">{formatINRCompact(b.netAmountPaise)}</span>
                        <StatusBadge status={b.status} kind="booking" />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {d.expenses && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Monthly expenses</CardTitle>
          </CardHeader>
          <CardContent className="h-56">
            {trend.every((t) => t.expenses === 0) ? (
              <EmptyState
                title="No expenses posted in the last 12 months"
                description="Expenses appear here once vouchers are posted to expense accounts."
              />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }} tickLine={false} axisLine={false} />
                  <YAxis
                    tickFormatter={axisRupees}
                    tick={{ fontSize: 12, fill: 'var(--muted-foreground)' }}
                    tickLine={false}
                    axisLine={false}
                    width={56}
                  />
                  <Tooltip
                    formatter={(v) => formatINR(Number(v))}
                    contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8 }}
                  />
                  <Bar dataKey="expenses" name="Expenses" fill="var(--chart-4)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
