import { model, Schema, type InferSchemaType } from 'mongoose';
import { ACCOUNT_TYPES, VOUCHER_TYPES } from '@erp/shared';
import { baseOptions, tenantRef, withTenant } from '../../db/base';

const accountSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      code: { type: String, required: true, trim: true },
      name: { type: String, required: true, trim: true },
      type: { type: String, enum: ACCOUNT_TYPES, required: true, immutable: true },
      parentId: { type: Schema.Types.ObjectId, ref: 'Account' },
      systemKey: String,
      isBank: { type: Boolean, default: false },
      isActive: { type: Boolean, default: true },
      description: String,
    },
    baseOptions,
  ),
);
accountSchema.index({ companyId: 1, code: 1 }, { unique: true });
accountSchema.index({ companyId: 1, systemKey: 1 }, { unique: true, partialFilterExpression: { systemKey: { $type: 'string' } } });
export type AccountDoc = InferSchemaType<typeof accountSchema>;
export const Account = model('Account', accountSchema);

const lineSchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'Account', required: true },
    debitPaise: { type: Number, required: true, min: 0, default: 0 },
    creditPaise: { type: Number, required: true, min: 0, default: 0 },
    narration: String,
    /** Party tagging lets customer ledgers be derived straight from the books. */
    customerId: { type: Schema.Types.ObjectId, ref: 'Customer' },
    bookingId: { type: Schema.Types.ObjectId, ref: 'Booking' },
    vendorId: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    brokerId: { type: Schema.Types.ObjectId, ref: 'Broker' },
  },
  { _id: false },
);

const journalSchema = withTenant(
  new Schema(
    {
      companyId: tenantRef,
      projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
      entryNumber: { type: String, required: true, immutable: true },
      voucherType: { type: String, enum: VOUCHER_TYPES, required: true, immutable: true },
      date: { type: Date, required: true, immutable: true },
      narration: { type: String, required: true, immutable: true },
      reference: { type: String, immutable: true },
      lines: { type: [lineSchema], required: true, immutable: true },
      totalPaise: { type: Number, required: true, immutable: true },
      source: {
        type: { type: String },
        id: { type: Schema.Types.ObjectId },
      },
      status: { type: String, enum: ['posted'], default: 'posted', immutable: true },
      reversalOf: { type: Schema.Types.ObjectId, ref: 'JournalEntry', immutable: true },
      /** The only field that may change after posting: set once when a reversal is posted. */
      reversedBy: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
      reversalReason: String,
      postedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    },
    baseOptions,
  ),
);
journalSchema.index({ companyId: 1, entryNumber: 1 }, { unique: true });
journalSchema.index({ companyId: 1, date: -1 });
journalSchema.index({ companyId: 1, 'lines.accountId': 1, date: 1 });
journalSchema.index({ companyId: 1, 'lines.customerId': 1, date: 1 });
journalSchema.index({ companyId: 1, 'lines.vendorId': 1, date: 1 }, { sparse: true });
journalSchema.index({ companyId: 1, 'lines.brokerId': 1, date: 1 }, { sparse: true });
journalSchema.index({ companyId: 1, 'source.type': 1, 'source.id': 1 });

// Posted entries are immutable: only the one-time reversal link may be written.
const ALLOWED_UPDATE_KEYS = new Set(['reversedBy', 'reversalReason', 'updatedAt']);
function guardUpdate(this: { getUpdate(): Record<string, unknown> | null }) {
  const update = this.getUpdate() ?? {};
  for (const [op, value] of Object.entries(update)) {
    // Mongoose timestamps add $setOnInsert.createdAt; harmless because upserts are never used here.
    if (op === '$setOnInsert' && value && Object.keys(value).every((k) => k === 'createdAt')) continue;
    if (op !== '$set' || typeof value !== 'object' || value === null) {
      throw new Error('Posted journal entries cannot be modified; post a reversal instead');
    }
    for (const key of Object.keys(value)) {
      if (!ALLOWED_UPDATE_KEYS.has(key)) throw new Error('Posted journal entries cannot be modified; post a reversal instead');
    }
  }
}
journalSchema.pre('updateOne', guardUpdate);
journalSchema.pre('findOneAndUpdate', guardUpdate);
journalSchema.pre('updateMany', function () {
  throw new Error('Bulk updates of journal entries are not allowed');
});
journalSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], function () {
  throw new Error('Journal entries cannot be deleted; post a reversal instead');
});
journalSchema.pre('validate', function () {
  const debit = this.lines.reduce((s, l) => s + l.debitPaise, 0);
  const credit = this.lines.reduce((s, l) => s + l.creditPaise, 0);
  if (debit !== credit || debit <= 0) throw new Error('Journal entry does not balance');
  if (this.lines.some((l) => l.debitPaise > 0 === l.creditPaise > 0)) throw new Error('Each line needs either a debit or a credit');
});
export type JournalEntryDoc = InferSchemaType<typeof journalSchema>;
export const JournalEntry = model('JournalEntry', journalSchema);
