/**
 * Permission catalog. Format: `<module>.<action>`.
 * The backend is the authoritative enforcement layer; the frontend uses the
 * same catalog only to hide actions the user cannot perform.
 */
export const PERMISSION_GROUPS = {
  dashboard: ['read'],
  company: ['read', 'update'],
  users: ['read', 'create', 'update', 'deactivate'],
  roles: ['read', 'create', 'update', 'delete'],
  projects: ['read', 'create', 'update', 'archive'],
  land: ['read', 'create', 'update', 'delete', 'pay'],
  inventory: ['read', 'create', 'update', 'status', 'delete'],
  map: ['read', 'edit'],
  crm: ['read', 'create', 'update', 'assign', 'delete'],
  customers: ['read', 'create', 'update', 'delete'],
  brokers: ['read', 'create', 'update', 'payout'],
  bookings: ['read', 'create', 'confirm', 'cancel', 'discount'],
  paymentPlans: ['read', 'create', 'update'],
  payments: ['read', 'create', 'reverse', 'refund'],
  accounting: ['read', 'create', 'reverse', 'manageAccounts'],
  reports: ['read', 'export'],
  construction: ['read', 'create', 'update'],
  vendors: ['read', 'create', 'update', 'pay'],
  expenses: ['read', 'create', 'reverse'],
  documents: ['read', 'upload', 'delete'],
  notifications: ['read'],
  audit: ['read'],
} as const;

type Groups = typeof PERMISSION_GROUPS;
export type Permission = {
  [K in keyof Groups]: `${K & string}.${Groups[K][number]}`;
}[keyof Groups];

export const ALL_PERMISSIONS: Permission[] = Object.entries(PERMISSION_GROUPS).flatMap(([group, actions]) =>
  (actions as readonly string[]).map((a) => `${group}.${a}` as Permission),
);

export const PERMISSION_LABELS: Record<string, string> = {
  dashboard: 'Dashboard',
  company: 'Company settings',
  users: 'Users',
  roles: 'Roles & permissions',
  projects: 'Projects',
  land: 'Land acquisition',
  inventory: 'Plot inventory',
  map: 'Plot map',
  crm: 'CRM & leads',
  customers: 'Customers',
  brokers: 'Brokers',
  bookings: 'Bookings',
  paymentPlans: 'Payment plans',
  payments: 'Payments & receipts',
  accounting: 'Accounting',
  reports: 'Reports',
  construction: 'Construction',
  vendors: 'Vendors',
  expenses: 'Expenses & bills',
  documents: 'Documents',
  notifications: 'Notifications',
  audit: 'Audit logs',
};

export function isPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

/** Default system roles created for every new company. */
export const SYSTEM_ROLES: Record<string, { name: string; description: string; permissions: Permission[] }> = {
  owner: {
    name: 'Owner',
    description: 'Full access to everything in the company',
    permissions: ALL_PERMISSIONS,
  },
  manager: {
    name: 'Project Manager',
    description: 'Manages projects, inventory, bookings and collections',
    permissions: ALL_PERMISSIONS.filter(
      (p) => !p.startsWith('roles.') && !['company.update', 'users.deactivate', 'accounting.manageAccounts'].includes(p),
    ),
  },
  sales: {
    name: 'Sales Executive',
    description: 'Leads, customers, quotations and bookings',
    permissions: [
      'dashboard.read',
      'projects.read',
      'inventory.read',
      'map.read',
      'crm.read',
      'crm.create',
      'crm.update',
      'customers.read',
      'customers.create',
      'customers.update',
      'crm.assign',
      'brokers.read',
      'brokers.create',
      'bookings.read',
      'bookings.create',
      'paymentPlans.read',
      'payments.read',
      'notifications.read',
      'documents.read',
      'documents.upload',
    ],
  },
  accountant: {
    name: 'Accountant',
    description: 'Receipts, vouchers and financial reports',
    permissions: [
      'dashboard.read',
      'projects.read',
      'inventory.read',
      'customers.read',
      'bookings.read',
      'paymentPlans.read',
      'payments.read',
      'payments.create',
      'payments.reverse',
      'payments.refund',
      'accounting.read',
      'accounting.create',
      'accounting.reverse',
      'reports.read',
      'reports.export',
      'notifications.read',
      'documents.read',
      'documents.upload',
      'land.read',
      'land.pay',
      'brokers.read',
      'brokers.payout',
      'vendors.read',
      'vendors.pay',
      'expenses.read',
      'expenses.create',
      'expenses.reverse',
      'construction.read',
    ],
  },
  viewer: {
    name: 'Viewer',
    description: 'Read-only access',
    permissions: ALL_PERMISSIONS.filter((p) => p.endsWith('.read')),
  },
};
