import { Types, type ClientSession } from 'mongoose';
import { financialYear, parseISODate, SYSTEM_ACCOUNTS, toISODate, type SystemAccountKey, type VoucherType } from '@erp/shared';
import { nextSequence } from '../../db/system.models';
import { businessRule, notFound } from '../../utils/errors';
import { Account, JournalEntry } from './accounting.models';

/**
 * Control accounts are maintained only by sub-ledger workflows (bookings, receipts, vendor
 * bills, broker commissions), so party ledgers always reconcile with the books.
 */
export const CONTROL_ACCOUNT_KEYS: SystemAccountKey[] = ['customer_receivable', 'customer_advance', 'refund_payable', 'vendor_payable', 'broker_payable'];

const VOUCHER_PREFIX: Record<VoucherType, string> = {
  journal: 'JV',
  receipt: 'RV',
  payment: 'PV',
  contra: 'CV',
  sales: 'SV',
  reversal: 'RJ',
};

export interface PostingLine {
  accountId?: Types.ObjectId | string;
  systemKey?: SystemAccountKey;
  debitPaise?: number;
  creditPaise?: number;
  narration?: string;
  customerId?: Types.ObjectId;
  bookingId?: Types.ObjectId;
  vendorId?: Types.ObjectId;
  brokerId?: Types.ObjectId;
}

export interface PostingInput {
  date: string; // YYYY-MM-DD
  voucherType: VoucherType;
  narration: string;
  reference?: string;
  projectId?: Types.ObjectId | string;
  lines: PostingLine[];
  source: { type: string; id?: Types.ObjectId };
  reversalOf?: Types.ObjectId;
  allowControlAccounts?: boolean;
}

interface Actor {
  companyId: Types.ObjectId;
  userId?: Types.ObjectId;
}

export async function systemAccountId(companyId: Types.ObjectId, key: SystemAccountKey, session?: ClientSession): Promise<Types.ObjectId> {
  const acc = await Account.findOne({ companyId, systemKey: key })
    .session(session ?? null)
    .select('_id')
    .lean();
  if (acc) return acc._id;
  // Companies created before a system account was introduced get it on first use.
  const def = SYSTEM_ACCOUNTS.find((a) => a.systemKey === key);
  if (!def) throw new Error(`Unknown system account ${key}`);
  const codeTaken = await Account.exists({ companyId, code: def.code }).session(session ?? null);
  const [created] = await Account.create(
    [{ companyId, systemKey: def.systemKey, code: codeTaken ? `${def.code}-S` : def.code, name: def.name, type: def.type }],
    { session },
  );
  return created!._id;
}

/**
 * Posts a balanced journal entry. Must run inside the caller's transaction so the entry
 * commits atomically with the business records it describes.
 */
export async function postJournal(actor: Actor, input: PostingInput, session: ClientSession) {
  const lines = [];
  const accountIds = new Set<string>();
  for (const l of input.lines) {
    const debit = l.debitPaise ?? 0;
    const credit = l.creditPaise ?? 0;
    if (!Number.isSafeInteger(debit) || !Number.isSafeInteger(credit) || debit < 0 || credit < 0) {
      throw businessRule('Journal amounts must be non-negative whole paise');
    }
    if (debit === 0 && credit === 0) continue; // drop zero lines produced by optional components
    const accountId = l.accountId ? new Types.ObjectId(String(l.accountId)) : await systemAccountId(actor.companyId, l.systemKey!, session);
    accountIds.add(String(accountId));
    lines.push({
      accountId,
      debitPaise: debit,
      creditPaise: credit,
      narration: l.narration,
      customerId: l.customerId,
      bookingId: l.bookingId,
      vendorId: l.vendorId,
      brokerId: l.brokerId,
    });
  }

  const debit = lines.reduce((s, l) => s + l.debitPaise, 0);
  const credit = lines.reduce((s, l) => s + l.creditPaise, 0);
  if (lines.length < 2 || debit !== credit || debit === 0) {
    throw businessRule(`Journal entry does not balance (debit ${debit}, credit ${credit})`);
  }

  const accounts = await Account.find({ companyId: actor.companyId, _id: { $in: [...accountIds].map((id) => new Types.ObjectId(id)) } })
    .session(session)
    .select('isActive systemKey name')
    .lean();
  if (accounts.length !== accountIds.size) throw businessRule('One or more accounts do not belong to this company');
  const inactive = accounts.find((a) => !a.isActive);
  if (inactive) throw businessRule(`Account "${inactive.name}" is inactive`);
  if (!input.allowControlAccounts) {
    const control = accounts.find((a) => a.systemKey && CONTROL_ACCOUNT_KEYS.includes(a.systemKey as SystemAccountKey));
    if (control) throw businessRule(`"${control.name}" is a control account and can only be posted through bookings and payments`);
  }

  const fy = financialYear(input.date);
  const seq = await nextSequence(actor.companyId, `je:${fy}`, session);
  const entryNumber = `${VOUCHER_PREFIX[input.voucherType]}/${fy}/${String(seq).padStart(6, '0')}`;

  const [entry] = await JournalEntry.create(
    [
      {
        companyId: actor.companyId,
        projectId: input.projectId,
        entryNumber,
        voucherType: input.voucherType,
        date: parseISODate(input.date),
        narration: input.narration,
        reference: input.reference,
        lines,
        totalPaise: debit,
        source: input.source,
        reversalOf: input.reversalOf,
        postedBy: actor.userId,
      },
    ],
    { session },
  );
  return entry!;
}

/** Posts the mirror image of an entry and links both. A reversal can never be reversed again. */
export async function reverseJournal(actor: Actor, entryId: Types.ObjectId, reason: string, session: ClientSession, date?: string) {
  const original = await JournalEntry.findOne({ companyId: actor.companyId, _id: entryId }).session(session).lean();
  if (!original) throw notFound('Journal entry');
  if (original.reversedBy) throw businessRule('This entry has already been reversed');
  if (original.reversalOf) throw businessRule('A reversal entry cannot itself be reversed');

  const reversal = await postJournal(
    actor,
    {
      date: date ?? toISODate(new Date()),
      voucherType: 'reversal',
      narration: `Reversal of ${original.entryNumber}: ${reason}`,
      reference: original.entryNumber,
      projectId: original.projectId ?? undefined,
      lines: original.lines.map((l) => ({
        accountId: l.accountId,
        debitPaise: l.creditPaise,
        creditPaise: l.debitPaise,
        narration: l.narration ?? undefined,
        customerId: l.customerId ?? undefined,
        bookingId: l.bookingId ?? undefined,
        vendorId: l.vendorId ?? undefined,
        brokerId: l.brokerId ?? undefined,
      })),
      source: { type: original.source?.type ?? 'manual', id: original.source?.id ?? undefined },
      reversalOf: original._id,
      allowControlAccounts: true,
    },
    session,
  );

  // Atomic guard: only one reversal can ever link to the original.
  const linked = await JournalEntry.updateOne(
    { companyId: actor.companyId, _id: original._id, reversedBy: null },
    { $set: { reversedBy: reversal._id, reversalReason: reason } },
    { session },
  );
  if (linked.modifiedCount !== 1) throw businessRule('This entry has already been reversed');
  return reversal;
}

/**
 * Cash/bank account for money in or out: an explicit active cash/bank asset account, or the
 * system Cash (mode = cash) / Bank account.
 */
export async function resolveCashAccountFor(companyId: Types.ObjectId, accountId: string | undefined, mode: string, session: ClientSession) {
  if (accountId) {
    if (!Types.ObjectId.isValid(accountId)) throw businessRule('Choose an active cash or bank account');
    const acc = await Account.findOne({ companyId, _id: new Types.ObjectId(accountId), type: 'asset', isActive: true }).session(session).lean();
    const isCashLike = acc && (acc.systemKey === 'cash' || acc.systemKey === 'bank' || acc.isBank || !acc.systemKey);
    if (!isCashLike) throw businessRule('Choose an active cash or bank account');
    return acc._id;
  }
  return systemAccountId(companyId, mode === 'cash' ? 'cash' : 'bank', session);
}

/** Party balance on a control account from tagged journal lines (credit − debit for liabilities). */
export async function partyBalance(
  companyId: Types.ObjectId,
  party: { vendorId?: Types.ObjectId; brokerId?: Types.ObjectId; customerId?: Types.ObjectId },
  accountKey: SystemAccountKey,
  session?: ClientSession,
): Promise<number> {
  const accountId = await systemAccountId(companyId, accountKey, session);
  const [field, value] = Object.entries(party).find(([, v]) => v)!;
  const rows = await JournalEntry.aggregate<{ debit: number; credit: number }>(
    [
      { $match: { companyId, [`lines.${field}`]: value } },
      { $unwind: '$lines' },
      { $match: { 'lines.accountId': accountId, [`lines.${field}`]: value } },
      { $group: { _id: null, debit: { $sum: '$lines.debitPaise' }, credit: { $sum: '$lines.creditPaise' } } },
    ],
    { session },
  );
  return (rows[0]?.credit ?? 0) - (rows[0]?.debit ?? 0);
}

/** "PV/2026-27/000123"-style number for a document series, allocated inside the transaction. */
export async function nextDocumentNumber(companyId: Types.ObjectId, series: string, date: string, session: ClientSession) {
  const fy = financialYear(date);
  const seq = await nextSequence(companyId, `${series.toLowerCase()}:${fy}`, session);
  return `${series}/${fy}/${String(seq).padStart(6, '0')}`;
}
