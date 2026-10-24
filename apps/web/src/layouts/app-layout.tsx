import * as React from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Handshake,
  HardHat,
  MapPinned,
  Receipt,
  Target,
  Truck,
  BookOpenCheck,
  Building2,
  CalendarClock,
  ChevronsLeft,
  ChevronsRight,
  FolderKanban,
  Grid3x3,
  Landmark,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  Moon,
  ReceiptIndianRupee,
  ScrollText,
  Search,
  Shield,
  ShieldCheck,
  Sun,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import type { Permission } from '@erp/shared';
import { api } from '@/lib/api';
import { cn, initials } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { useAuth } from '@/features/auth/auth-context';
import { Logo } from '@/features/auth/auth-pages';
import { useProjectContext } from '@/hooks/use-project';
import { useDebounced } from '@/hooks/use-list-params';
import { Button } from '@/components/ui/button';
import { Input, Popover, PopoverContent, PopoverTrigger, Select, Tooltip } from '@/components/ui/primitives';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/overlays';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission: Permission;
  end?: boolean;
}

const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Overview',
    items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, permission: 'dashboard.read', end: true }],
  },
  {
    section: 'Projects',
    items: [
      { to: '/projects', label: 'Projects', icon: FolderKanban, permission: 'projects.read' },
      { to: '/inventory', label: 'Plot inventory', icon: Grid3x3, permission: 'inventory.read' },
      { to: '/map', label: 'Plot map', icon: Map, permission: 'map.read' },
      { to: '/land', label: 'Land acquisition', icon: MapPinned, permission: 'land.read' },
    ],
  },
  {
    section: 'Sales',
    items: [
      { to: '/crm', label: 'Leads', icon: Target, permission: 'crm.read' },
      { to: '/customers', label: 'Customers', icon: Users, permission: 'customers.read' },
      { to: '/bookings', label: 'Bookings', icon: BookOpenCheck, permission: 'bookings.read' },
      { to: '/payment-plans', label: 'Payment plans', icon: CalendarClock, permission: 'paymentPlans.read' },
      { to: '/payments', label: 'Receipts & refunds', icon: ReceiptIndianRupee, permission: 'payments.read' },
      { to: '/brokers', label: 'Brokers', icon: Handshake, permission: 'brokers.read' },
    ],
  },
  {
    section: 'Construction',
    items: [
      { to: '/work-orders', label: 'Work orders', icon: HardHat, permission: 'construction.read' },
      { to: '/vendors', label: 'Vendors', icon: Truck, permission: 'vendors.read' },
      { to: '/expenses', label: 'Expenses & bills', icon: Receipt, permission: 'expenses.read' },
    ],
  },
  {
    section: 'Finance',
    items: [{ to: '/accounting', label: 'Accounting', icon: Landmark, permission: 'accounting.read' }],
  },
  {
    section: 'Administration',
    items: [
      { to: '/admin/users', label: 'Users', icon: UserCog, permission: 'users.read' },
      { to: '/admin/roles', label: 'Roles & permissions', icon: ShieldCheck, permission: 'roles.read' },
      { to: '/admin/audit', label: 'Audit log', icon: ScrollText, permission: 'audit.read' },
      { to: '/admin/company', label: 'Company settings', icon: Building2, permission: 'company.read' },
    ],
  },
];

function readPref(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function Sidebar({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { can } = useAuth();
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4">
      {NAV.map((group) => {
        const items = group.items.filter((i) => can(i.permission));
        if (!items.length) return null;
        return (
          <div key={group.section} className="mb-5">
            {!collapsed && (
              <p className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-wider text-sidebar-muted/80">{group.section}</p>
            )}
            <ul className="space-y-0.5">
              {items.map((item) => {
                const link = (
                  <NavLink
                    to={item.to}
                    end={item.end}
                    onClick={onNavigate}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-md px-3 py-2 text-sm text-sidebar-foreground/85 transition-colors hover:bg-sidebar-active hover:text-white',
                        isActive && 'bg-sidebar-active font-medium text-white',
                        collapsed && 'justify-center px-2',
                      )
                    }
                  >
                    <item.icon className="size-[18px] shrink-0" />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                    {collapsed && <span className="sr-only">{item.label}</span>}
                  </NavLink>
                );
                return (
                  <li key={item.to}>
                    {collapsed ? (
                      <Tooltip content={item.label} side="right">
                        {link}
                      </Tooltip>
                    ) : (
                      link
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

interface SearchResults {
  projects: { id: string; name: string; code: string }[];
  plots: { id: string; plotNumber: string; projectId: string; status: string }[];
  customers: { id: string; name: string; phone: string; customerCode: string }[];
  bookings: { id: string; bookingNumber: string; status: string }[];
  leads?: { id: string; name: string; phone: string; status: string }[];
  vendors?: { id: string; name: string; category: string }[];
  land?: { id: string; khasraNumber: string; village: string; status: string }[];
}

function GlobalSearch() {
  const [q, setQ] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const debounced = useDebounced(q.trim(), 250);
  const navigate = useNavigate();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<SearchResults>('/search', { q: debounced }),
    enabled: debounced.length >= 2,
  });

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const go = (to: string) => {
    setOpen(false);
    setQ('');
    navigate(to);
  };
  const groups = data
    ? [
        {
          label: 'Bookings',
          items: data.bookings.map((b) => ({ key: b.id, title: b.bookingNumber, sub: b.status, to: `/bookings/${b.id}` })),
        },
        {
          label: 'Customers',
          items: data.customers.map((c) => ({ key: c.id, title: c.name, sub: `${c.customerCode} · ${c.phone}`, to: `/customers/${c.id}` })),
        },
        {
          label: 'Plots',
          items: data.plots.map((p) => ({
            key: p.id,
            title: `Plot ${p.plotNumber}`,
            sub: p.status,
            to: `/inventory?project=${p.projectId}&plot=${p.id}`,
          })),
        },
        { label: 'Projects', items: data.projects.map((p) => ({ key: p.id, title: p.name, sub: p.code, to: `/projects/${p.id}` })) },
        {
          label: 'Leads',
          items: (data.leads ?? []).map((l) => ({ key: l.id, title: l.name, sub: `${l.phone} · ${l.status}`, to: `/crm?lead=${l.id}` })),
        },
        {
          label: 'Vendors',
          items: (data.vendors ?? []).map((v) => ({ key: v.id, title: v.name, sub: v.category, to: `/vendors/${v.id}` })),
        },
        {
          label: 'Land',
          items: (data.land ?? []).map((l) => ({
            key: l.id,
            title: `Khasra ${l.khasraNumber}`,
            sub: `${l.village} · ${l.status}`,
            to: `/land/${l.id}`,
          })),
        },
      ].filter((g) => g.items.length)
    : [];

  return (
    <Popover open={open && debounced.length >= 2} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            placeholder="Search bookings, customers, plots…"
            className="h-9 bg-muted/50 pl-8 pr-14"
            aria-label="Global search"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border bg-card px-1.5 text-[10px] text-muted-foreground sm:block">
            Ctrl K
          </kbd>
        </div>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
        {isFetching && !data ? (
          <p className="p-3 text-sm text-muted-foreground">Searching…</p>
        ) : groups.length === 0 ? (
          <p className="p-3 text-sm text-muted-foreground">No matches</p>
        ) : (
          groups.map((g) => (
            <div key={g.label} className="py-1">
              <p className="px-2 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{g.label}</p>
              {g.items.map((i) => (
                <button
                  key={i.key}
                  type="button"
                  onClick={() => go(i.to)}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted cursor-pointer"
                >
                  <span className="truncate font-medium">{i.title}</span>
                  <span className="ml-2 shrink-0 text-xs text-muted-foreground">{i.sub}</span>
                </button>
              ))}
            </div>
          ))
        )}
      </PopoverContent>
    </Popover>
  );
}

interface NotificationItem {
  id: string;
  title: string;
  body?: string;
  link?: string;
  readAt?: string;
  createdAt: string;
}

function Notifications() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ items: NotificationItem[]; unread: number }>('/notifications', { pageSize: 15 }),
    refetchInterval: 60_000,
  });
  const markAll = useMutation({
    mutationFn: () => api.post('/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markOne = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const unread = data?.unread ?? 0;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
          <Bell />
          {unread > 0 && (
            <span className="absolute right-1.5 top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <p className="font-semibold">Notifications</p>
          {unread > 0 && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={() => markAll.mutate()}>
              Mark all read
            </Button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {!data?.items.length ? (
            <p className="p-6 text-center text-sm text-muted-foreground">You’re all caught up.</p>
          ) : (
            data.items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => {
                  if (!n.readAt) markOne.mutate(n.id);
                  if (n.link) navigate(n.link);
                }}
                className={cn(
                  'flex w-full gap-3 border-b px-4 py-3 text-left last:border-0 hover:bg-muted/60 cursor-pointer',
                  !n.readAt && 'bg-accent/40',
                )}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-primary')} aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{n.title}</span>
                  {n.body && <span className="block text-sm text-muted-foreground">{n.body}</span>}
                  <span className="mt-0.5 block text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ProjectSelector() {
  const { projects, projectId, setProjectId } = useProjectContext();
  if (!projects.length) return null;
  return (
    <Select
      value={projectId ?? ''}
      onChange={(e) => setProjectId(e.target.value || null)}
      className="h-9 w-40 sm:w-52"
      aria-label="Current project"
    >
      <option value="">All projects</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

function UserMenu({ dark, toggleDark }: { dark: boolean; toggleDark: () => void }) {
  const { context, logout, selectCompany } = useAuth();
  const navigate = useNavigate();
  if (!context) return null;
  const others = context.companies.filter((c) => c.id !== context.activeCompany?.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-full p-0.5 pr-2 hover:bg-muted cursor-pointer"
          aria-label="Account menu"
        >
          <span className="flex size-8 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {initials(context.user.name)}
          </span>
          <span className="hidden text-left lg:block">
            <span className="block text-sm font-medium leading-tight">{context.user.name}</span>
            <span className="block text-xs leading-tight text-muted-foreground">{context.activeCompany?.roleName}</span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-64">
        <DropdownMenuLabel>
          <span className="block text-sm font-medium text-foreground">{context.user.name}</span>
          <span className="block truncate">{context.user.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/account')}>
          <Shield /> Account & sessions
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={toggleDark}>
          {dark ? <Sun /> : <Moon />} {dark ? 'Light mode' : 'Dark mode'}
        </DropdownMenuItem>
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Switch company</DropdownMenuLabel>
            {others.map((c) => (
              <DropdownMenuItem key={c.id} onSelect={() => void selectCompany(c.id).then(() => navigate('/'))}>
                <Building2 /> {c.name}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive onSelect={() => void logout().then(() => window.location.assign('/login'))}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AppLayout() {
  const { context } = useAuth();
  const location = useLocation();
  const [collapsed, setCollapsed] = React.useState(() => readPref('erp.sidebar', 'open') === 'collapsed');
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [dark, setDark] = React.useState(() => readPref('erp.theme', 'light') === 'dark');

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    writePref('erp.theme', dark ? 'dark' : 'light');
  }, [dark]);
  React.useEffect(() => setMobileOpen(false), [location.pathname]);

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      writePref('erp.sidebar', c ? 'open' : 'collapsed');
      return !c;
    });
  };

  return (
    <div className="flex min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-card focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 md:flex',
          collapsed ? 'w-16' : 'w-64',
        )}
      >
        <div className={cn('flex h-14 items-center border-b border-sidebar-border px-4', collapsed && 'justify-center px-0')}>
          <Link to="/" className="text-white" aria-label="Plotline home">
            {collapsed ? (
              <svg viewBox="0 0 32 32" className="size-7" aria-hidden>
                <rect width="32" height="32" rx="8" fill="#0f766e" />
                <path d="M7 9h8v6H7zM17 9h8v6h-8zM7 17h8v6H7z" fill="#ecfdf5" />
                <path d="M17 17h8v6h-8z" fill="#f59e0b" />
              </svg>
            ) : (
              <Logo />
            )}
          </Link>
        </div>
        {!collapsed && context?.activeCompany && (
          <div className="mx-3 mt-3 rounded-md bg-sidebar-active/60 px-3 py-2">
            <p className="text-[11px] uppercase tracking-wide text-sidebar-muted">Company</p>
            <p className="truncate text-sm font-medium text-white">{context.activeCompany.name}</p>
          </div>
        )}
        <Sidebar collapsed={collapsed} />
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex h-11 items-center justify-center gap-2 border-t border-sidebar-border text-sm text-sidebar-muted hover:text-white cursor-pointer"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          {!collapsed && 'Collapse'}
        </button>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
          <div className="absolute inset-0 bg-slate-950/50" onClick={() => setMobileOpen(false)} />
          <aside className="relative flex h-full w-72 flex-col bg-sidebar">
            <div className="flex h-14 items-center justify-between border-b border-sidebar-border px-4 text-white">
              <Logo />
              <button type="button" onClick={() => setMobileOpen(false)} aria-label="Close navigation" className="cursor-pointer">
                <X className="size-5" />
              </button>
            </div>
            <Sidebar collapsed={false} onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-card/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-card/80">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu />
          </Button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            <ProjectSelector />
            <Notifications />
            <UserMenu dark={dark} toggleDark={() => setDark((d) => !d)} />
          </div>
        </header>
        {context && !context.user.emailVerified && <VerifyBanner />}
        <main id="main" className="mx-auto w-full max-w-[1400px] flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function VerifyBanner() {
  const [sent, setSent] = React.useState(false);
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 border-b bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      Please verify your email address.
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-amber-900 dark:text-amber-200"
        disabled={sent}
        onClick={() => void api.post('/auth/resend-verification').then(() => setSent(true))}
      >
        {sent ? 'Verification email sent' : 'Resend link'}
      </Button>
    </div>
  );
}
