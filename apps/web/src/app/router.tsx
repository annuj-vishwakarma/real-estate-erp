import * as React from 'react';
import { createBrowserRouter, Navigate, useLocation } from 'react-router-dom';
import type { Permission } from '@erp/shared';
import { useAuth } from '@/features/auth/auth-context';
import {
  AcceptInvitePage,
  ForgotPasswordPage,
  LoginPage,
  RegisterPage,
  ResetPasswordPage,
  SelectCompanyPage,
  VerifyEmailPage,
} from '@/features/auth/auth-pages';
import { AppLayout } from '@/layouts/app-layout';
import { ProjectProvider } from '@/hooks/use-project';
import { PageSkeleton, PermissionDenied, EmptyState } from '@/components/states';

// Route-level code splitting: each feature module loads on first visit.
const lazy = <T, K extends keyof T>(loader: () => Promise<T>, name: K) =>
  React.lazy(() => loader().then((m) => ({ default: m[name] as unknown as React.ComponentType })));

const DashboardPage = lazy(() => import('@/features/dashboard/dashboard-page'), 'DashboardPage');
const ProjectsPage = lazy(() => import('@/features/projects/projects-pages'), 'ProjectsPage');
const ProjectDetailPage = lazy(() => import('@/features/projects/projects-pages'), 'ProjectDetailPage');
const InventoryPage = lazy(() => import('@/features/inventory/inventory-page'), 'InventoryPage');
const MapPage = lazy(() => import('@/features/map/map-page'), 'MapPage');
const CustomersPage = lazy(() => import('@/features/customers/customers-pages'), 'CustomersPage');
const CustomerDetailPage = lazy(() => import('@/features/customers/customers-pages'), 'CustomerDetailPage');
const BookingsPage = lazy(() => import('@/features/bookings/bookings-pages'), 'BookingsPage');
const NewBookingPage = lazy(() => import('@/features/bookings/bookings-pages'), 'NewBookingPage');
const BookingDetailPage = lazy(() => import('@/features/bookings/bookings-pages'), 'BookingDetailPage');
const PaymentPlansPage = lazy(() => import('@/features/bookings/payment-plans-page'), 'PaymentPlansPage');
const PaymentsPage = lazy(() => import('@/features/payments/payments-pages'), 'PaymentsPage');
const PaymentDetailPage = lazy(() => import('@/features/payments/payments-pages'), 'PaymentDetailPage');
const AccountingPage = lazy(() => import('@/features/accounting/accounting-pages'), 'AccountingPage');
const JournalEntryPage = lazy(() => import('@/features/accounting/accounting-pages'), 'JournalEntryPage');
const UsersPage = lazy(() => import('@/features/admin/admin-pages'), 'UsersPage');
const RolesPage = lazy(() => import('@/features/admin/admin-pages'), 'RolesPage');
const AuditPage = lazy(() => import('@/features/admin/admin-pages'), 'AuditPage');
const CompanySettingsPage = lazy(() => import('@/features/admin/admin-pages'), 'CompanySettingsPage');
const AccountPage = lazy(() => import('@/features/admin/admin-pages'), 'AccountPage');
const LandPage = lazy(() => import('@/features/land/land-pages'), 'LandPage');
const LandDetailPage = lazy(() => import('@/features/land/land-pages'), 'LandDetailPage');
const CrmPage = lazy(() => import('@/features/crm/crm-pages'), 'CrmPage');
const BrokersPage = lazy(() => import('@/features/brokers/brokers-pages'), 'BrokersPage');
const BrokerDetailPage = lazy(() => import('@/features/brokers/brokers-pages'), 'BrokerDetailPage');
const VendorsPage = lazy(() => import('@/features/construction/construction-pages'), 'VendorsPage');
const VendorDetailPage = lazy(() => import('@/features/construction/construction-pages'), 'VendorDetailPage');
const WorkOrdersPage = lazy(() => import('@/features/construction/construction-pages'), 'WorkOrdersPage');
const WorkOrderDetailPage = lazy(() => import('@/features/construction/construction-pages'), 'WorkOrderDetailPage');
const ExpensesPage = lazy(() => import('@/features/construction/construction-pages'), 'ExpensesPage');

/** Route guard: requires a session and a selected company. UX only; the API enforces access. */
function RequireAuth() {
  const { status, context } = useAuth();
  const location = useLocation();
  if (status === 'loading')
    return (
      <div className="p-6">
        <PageSkeleton />
      </div>
    );
  if (status === 'anonymous') return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  if (!context?.activeCompany) return <Navigate to="/select-company" replace />;
  return (
    <ProjectProvider>
      <AppLayout />
    </ProjectProvider>
  );
}

function Guard({ permission, children }: { permission: Permission; children: React.ReactNode }) {
  const { can } = useAuth();
  if (!can(permission)) return <PermissionDenied />;
  return <React.Suspense fallback={<PageSkeleton />}>{children}</React.Suspense>;
}

function NotFound() {
  return <EmptyState title="Page not found" description="The page you’re looking for doesn’t exist." />;
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  { path: '/forgot-password', element: <ForgotPasswordPage /> },
  { path: '/reset-password', element: <ResetPasswordPage /> },
  { path: '/verify-email', element: <VerifyEmailPage /> },
  { path: '/accept-invite', element: <AcceptInvitePage /> },
  { path: '/select-company', element: <SelectCompanyPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        index: true,
        element: (
          <Guard permission="dashboard.read">
            <DashboardPage />
          </Guard>
        ),
      },
      {
        path: 'projects',
        element: (
          <Guard permission="projects.read">
            <ProjectsPage />
          </Guard>
        ),
      },
      {
        path: 'projects/:id',
        element: (
          <Guard permission="projects.read">
            <ProjectDetailPage />
          </Guard>
        ),
      },
      {
        path: 'inventory',
        element: (
          <Guard permission="inventory.read">
            <InventoryPage />
          </Guard>
        ),
      },
      {
        path: 'map',
        element: (
          <Guard permission="map.read">
            <MapPage />
          </Guard>
        ),
      },
      {
        path: 'customers',
        element: (
          <Guard permission="customers.read">
            <CustomersPage />
          </Guard>
        ),
      },
      {
        path: 'customers/:id',
        element: (
          <Guard permission="customers.read">
            <CustomerDetailPage />
          </Guard>
        ),
      },
      {
        path: 'bookings',
        element: (
          <Guard permission="bookings.read">
            <BookingsPage />
          </Guard>
        ),
      },
      {
        path: 'bookings/new',
        element: (
          <Guard permission="bookings.create">
            <NewBookingPage />
          </Guard>
        ),
      },
      {
        path: 'bookings/:id',
        element: (
          <Guard permission="bookings.read">
            <BookingDetailPage />
          </Guard>
        ),
      },
      {
        path: 'payment-plans',
        element: (
          <Guard permission="paymentPlans.read">
            <PaymentPlansPage />
          </Guard>
        ),
      },
      {
        path: 'payments',
        element: (
          <Guard permission="payments.read">
            <PaymentsPage />
          </Guard>
        ),
      },
      {
        path: 'payments/:id',
        element: (
          <Guard permission="payments.read">
            <PaymentDetailPage />
          </Guard>
        ),
      },
      {
        path: 'accounting',
        element: (
          <Guard permission="accounting.read">
            <AccountingPage />
          </Guard>
        ),
      },
      {
        path: 'accounting/entries/:id',
        element: (
          <Guard permission="accounting.read">
            <JournalEntryPage />
          </Guard>
        ),
      },
      {
        path: 'admin/users',
        element: (
          <Guard permission="users.read">
            <UsersPage />
          </Guard>
        ),
      },
      {
        path: 'admin/roles',
        element: (
          <Guard permission="roles.read">
            <RolesPage />
          </Guard>
        ),
      },
      {
        path: 'admin/audit',
        element: (
          <Guard permission="audit.read">
            <AuditPage />
          </Guard>
        ),
      },
      {
        path: 'admin/company',
        element: (
          <Guard permission="company.read">
            <CompanySettingsPage />
          </Guard>
        ),
      },
      {
        path: 'land',
        element: (
          <Guard permission="land.read">
            <LandPage />
          </Guard>
        ),
      },
      {
        path: 'land/:id',
        element: (
          <Guard permission="land.read">
            <LandDetailPage />
          </Guard>
        ),
      },
      {
        path: 'crm',
        element: (
          <Guard permission="crm.read">
            <CrmPage />
          </Guard>
        ),
      },
      {
        path: 'brokers',
        element: (
          <Guard permission="brokers.read">
            <BrokersPage />
          </Guard>
        ),
      },
      {
        path: 'brokers/:id',
        element: (
          <Guard permission="brokers.read">
            <BrokerDetailPage />
          </Guard>
        ),
      },
      {
        path: 'vendors',
        element: (
          <Guard permission="vendors.read">
            <VendorsPage />
          </Guard>
        ),
      },
      {
        path: 'vendors/:id',
        element: (
          <Guard permission="vendors.read">
            <VendorDetailPage />
          </Guard>
        ),
      },
      {
        path: 'work-orders',
        element: (
          <Guard permission="construction.read">
            <WorkOrdersPage />
          </Guard>
        ),
      },
      {
        path: 'work-orders/:id',
        element: (
          <Guard permission="construction.read">
            <WorkOrderDetailPage />
          </Guard>
        ),
      },
      {
        path: 'expenses',
        element: (
          <Guard permission="expenses.read">
            <ExpensesPage />
          </Guard>
        ),
      },
      {
        path: 'account',
        element: (
          <React.Suspense fallback={<PageSkeleton />}>
            <AccountPage />
          </React.Suspense>
        ),
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
