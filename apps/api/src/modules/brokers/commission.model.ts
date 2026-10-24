import { model, Schema } from 'mongoose';
import { COMMISSION_STATUSES, PAYMENT_MODES } from '@erp/shared';
import { baseOptions, tenantRef, withTenant } from '../../db/base';

/**
 * Broker commission accrued when a booking is confirmed (Dr Brokerage, Cr Brokerage Payable)
 * and settled by a payout (Dr Brokerage Payable, Cr Cash/Bank).
 */
const commissionSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      brokerId: { type: Schema.Types.ObjectId, ref: 'Broker', required: true },
      bookingId: { type: Schema.Types.ObjectId, ref: 'Booking', required: true },
      projectId: { type: Schema.Types.ObjectId, ref: 'Project', required: true },
      basePaise: { type: Number, required: true, min: 0 },
      rateBp: { type: Number, required: true, min: 0, max: 10_000 },
      amountPaise: { type: Number, required: true, min: 1 },
      status: { type: String, enum: COMMISSION_STATUSES, default: 'accrued', required: true },
      accrualJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      cancelJournalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      payout: {
        number: String,
        paidOn: Date,
        mode: { type: String, enum: PAYMENT_MODES },
        accountId: { type: Schema.Types.ObjectId, ref: 'Account' },
        reference: String,
        journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      },
    },
    baseOptions,
  ),
);
// One commission per booking: re-confirmation can never accrue twice.
commissionSchema.index({ companyId: 1, bookingId: 1 }, { unique: true });
commissionSchema.index({ companyId: 1, brokerId: 1, status: 1 });
export const BrokerCommission = model('BrokerCommission', commissionSchema);
