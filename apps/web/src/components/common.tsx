import * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { BookingStatus, PlotStatus } from '@erp/shared';
import { cn } from '@/lib/utils';
import { titleCase } from '@/lib/format';
import { Badge, type BadgeVariant, Card, Label } from './ui/primitives';

export interface Crumb {
  label: string;
  to?: string;
}

export function PageHeader({
  title,
  description,
  breadcrumbs,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  breadcrumbs?: Crumb[];
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-3">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav aria-label="Breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            {breadcrumbs.map((c, i) => (
              <li key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3.5" aria-hidden />}
                {c.to ? (
                  <Link to={c.to} className="hover:text-foreground">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-foreground">
                    {c.label}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export const PLOT_STATUS_META: Record<PlotStatus, { label: string; variant: BadgeVariant; color: string }> = {
  available: { label: 'Available', variant: 'success', color: 'var(--plot-available)' },
  reserved: { label: 'Reserved', variant: 'warning', color: 'var(--plot-reserved)' },
  booked: { label: 'Booked', variant: 'info', color: 'var(--plot-booked)' },
  sold: { label: 'Sold', variant: 'violet', color: 'var(--plot-sold)' },
  blocked: { label: 'Blocked', variant: 'muted', color: 'var(--plot-blocked)' },
};

const BOOKING_VARIANT: Record<BookingStatus, BadgeVariant> = {
  reserved: 'warning',
  booked: 'info',
  cancelled: 'destructive',
  expired: 'muted',
};
const GENERIC_VARIANT: Record<string, BadgeVariant> = {
  active: 'success',
  planning: 'info',
  completed: 'violet',
  on_hold: 'warning',
  archived: 'muted',
  pending: 'muted',
  partial: 'warning',
  paid: 'success',
  cancelled: 'destructive',
  received: 'success',
  reversed: 'destructive',
  invited: 'warning',
  disabled: 'muted',
  overdue: 'destructive',
};

export function StatusBadge({ status, kind, label }: { status: string; kind?: 'plot' | 'booking'; label?: string }) {
  if (kind === 'plot' && status in PLOT_STATUS_META) {
    const m = PLOT_STATUS_META[status as PlotStatus];
    return (
      <Badge variant={m.variant}>
        <span className="size-1.5 rounded-full" style={{ background: m.color }} aria-hidden />
        {m.label}
      </Badge>
    );
  }
  const variant = kind === 'booking' ? BOOKING_VARIANT[status as BookingStatus] : GENERIC_VARIANT[status];
  return <Badge variant={variant ?? 'secondary'}>{label ?? titleCase(status)}</Badge>;
}

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = 'default',
  loading,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: 'default' | 'warning' | 'success' | 'danger';
  loading?: boolean;
}) {
  const toneClass = {
    default: 'bg-primary/10 text-primary',
    warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
    success: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
    danger: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
  }[tone];
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{label}</p>
          {loading ? (
            <div className="mt-2 h-7 w-28 animate-pulse rounded bg-muted" />
          ) : (
            <p className="mt-1 truncate text-2xl font-semibold tabular">{value}</p>
          )}
          {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
        </div>
        {Icon && (
          <div className={cn('rounded-lg p-2', toneClass)}>
            <Icon className="size-5" />
          </div>
        )}
      </div>
    </Card>
  );
}

/** Label + control + error message, wired for accessibility. */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  children: React.ReactElement<{ 'aria-invalid'?: boolean; 'aria-describedby'?: string; id?: string }>;
}) {
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required && (
          <span className="ml-0.5 text-destructive" aria-hidden>
            *
          </span>
        )}
      </Label>
      {React.cloneElement(children, { id: htmlFor, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy })}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function DescriptionList({ items, className }: { items: { label: string; value: React.ReactNode }[]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2', className)}>
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">{i.label}</dt>
          <dd className="mt-0.5 truncate text-sm">{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
