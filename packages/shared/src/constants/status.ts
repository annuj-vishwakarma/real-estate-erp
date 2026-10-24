export const PLOT_STATUSES = ['available', 'reserved', 'booked', 'sold', 'blocked'] as const;
export type PlotStatus = (typeof PLOT_STATUSES)[number];

/** Manual transitions an operator may perform from the inventory screen. */
export const MANUAL_PLOT_TRANSITIONS: Record<PlotStatus, PlotStatus[]> = {
  available: ['blocked'],
  blocked: ['available'],
  reserved: [],
  booked: ['sold'],
  sold: [],
};

export const PLOT_FACINGS = ['north', 'south', 'east', 'west', 'north_east', 'north_west', 'south_east', 'south_west'] as const;
export const PLOT_CATEGORIES = ['residential', 'commercial', 'mixed', 'amenity'] as const;

export const BOOKING_STATUSES = ['reserved', 'booked', 'cancelled', 'expired'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Booking state machine. Terminal states have no outgoing transitions. */
export const BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  reserved: ['booked', 'cancelled', 'expired'],
  booked: ['cancelled'],
  cancelled: [],
  expired: [],
};

export function canTransitionBooking(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from].includes(to);
}

export const PROJECT_STATUSES = ['planning', 'active', 'completed', 'on_hold', 'archived'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PAYMENT_MODES = ['cash', 'cheque', 'upi', 'neft', 'rtgs', 'imps', 'card', 'demand_draft', 'other'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

export const PAYMENT_STATUSES = ['received', 'reversed'] as const;
export const PAYMENT_KINDS = ['receipt', 'refund'] as const;

export const INSTALLMENT_STATUSES = ['pending', 'partial', 'paid', 'cancelled'] as const;
export type InstallmentStatus = (typeof INSTALLMENT_STATUSES)[number];

export const ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'income', 'expense'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** Normal balance side by account type. */
export const NORMAL_BALANCE: Record<AccountType, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  income: 'credit',
};

export const VOUCHER_TYPES = ['journal', 'receipt', 'payment', 'contra', 'sales', 'reversal'] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/**
 * System accounts every company gets. Services look these up by `systemKey`,
 * never by name, so users may rename them.
 */
export const SYSTEM_ACCOUNTS = [
  { systemKey: 'cash', code: '1000', name: 'Cash in Hand', type: 'asset' },
  { systemKey: 'bank', code: '1010', name: 'Bank Account', type: 'asset' },
  { systemKey: 'customer_receivable', code: '1100', name: 'Customer Receivables', type: 'asset' },
  { systemKey: 'land_inventory', code: '1300', name: 'Land & Development (WIP)', type: 'asset' },
  { systemKey: 'customer_advance', code: '2100', name: 'Customer Advances', type: 'liability' },
  { systemKey: 'refund_payable', code: '2200', name: 'Refunds Payable', type: 'liability' },
  { systemKey: 'vendor_payable', code: '2300', name: 'Vendor Payables', type: 'liability' },
  { systemKey: 'broker_payable', code: '2400', name: 'Brokerage Payable', type: 'liability' },
  { systemKey: 'capital', code: '3000', name: "Owner's Capital", type: 'equity' },
  { systemKey: 'plot_sales', code: '4000', name: 'Plot Sales', type: 'income' },
  { systemKey: 'cancellation_income', code: '4100', name: 'Cancellation Charges', type: 'income' },
  { systemKey: 'other_income', code: '4900', name: 'Other Income', type: 'income' },
  { systemKey: 'development_expense', code: '5000', name: 'Development Expenses', type: 'expense' },
  { systemKey: 'admin_expense', code: '5100', name: 'Administrative Expenses', type: 'expense' },
  { systemKey: 'brokerage_expense', code: '5200', name: 'Brokerage & Commission', type: 'expense' },
] as const;
export type SystemAccountKey = (typeof SYSTEM_ACCOUNTS)[number]['systemKey'];

export const OVERPAYMENT_POLICIES = ['reject', 'advance'] as const;
export type OverpaymentPolicy = (typeof OVERPAYMENT_POLICIES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'invited', 'disabled'] as const;

export const LEAD_STATUSES = ['new', 'contacted', 'site_visit', 'negotiation', 'won', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const OPEN_LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'site_visit', 'negotiation'];
export const LEAD_SOURCES = ['walk_in', 'website', 'facebook', 'google', 'broker', 'referral', 'hoarding', 'other'] as const;
export const LEAD_ACTIVITY_TYPES = ['call', 'whatsapp', 'email', 'meeting', 'site_visit', 'note', 'status_change'] as const;
export const LAND_STATUSES = ['negotiation', 'agreement', 'registered', 'converted', 'dropped'] as const;
export type LandStatus = (typeof LAND_STATUSES)[number];
/** Land acquisition pipeline; `dropped` is terminal and reachable before registry. */
export const LAND_TRANSITIONS: Record<LandStatus, LandStatus[]> = {
  negotiation: ['agreement', 'dropped'],
  agreement: ['registered', 'dropped'],
  registered: ['converted'],
  converted: [],
  dropped: [],
};
export const LAND_AREA_UNITS = ['sqft', 'sqm', 'acre', 'bigha', 'hectare'] as const;
export const WORK_ORDER_STATUSES = ['draft', 'issued', 'in_progress', 'completed', 'cancelled'] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];
export const WORK_ORDER_TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  draft: ['issued', 'cancelled'],
  issued: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};
export const VENDOR_CATEGORIES = ['civil', 'electrical', 'plumbing', 'road', 'landscaping', 'material', 'consultant', 'other'] as const;
export const COMMISSION_STATUSES = ['accrued', 'paid', 'cancelled'] as const;
export const EXPENSE_SETTLEMENTS = ['paid', 'payable'] as const;
export const DOCUMENT_ENTITY_TYPES = ['project', 'land_parcel', 'plot', 'customer', 'booking', 'payment', 'vendor', 'work_order', 'lead', 'company'] as const;
export type DocumentEntityType = (typeof DOCUMENT_ENTITY_TYPES)[number];
export const DOCUMENT_CATEGORIES = ['general', 'agreement', 'registry', 'kyc', 'layout_plan', 'approval', 'invoice', 'receipt', 'photo', 'other'] as const;
/** File types accepted for upload; the server also verifies file signatures (magic bytes). */
export const ALLOWED_UPLOAD_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
};
