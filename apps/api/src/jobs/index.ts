import cron, { type ScheduledTask } from 'node-cron';
import { Types } from 'mongoose';
import { addDays, formatDate, formatINR, parseISODate, todayInIndia } from '@erp/shared';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { expireReservations } from '../modules/bookings/bookings.service';
import { runFollowUpReminders } from '../modules/crm/crm.service';
import { Booking, Installment } from '../modules/bookings/booking.models';
import { Notification } from '../modules/notifications/notification.model';
import { Membership } from '../modules/users/user.models';
import { Role } from '../modules/roles/role.models';

/**
 * Creates in-app reminders for installments that fall due within the reminder window or
 * are overdue. One notification per installment per user per day (dedupe key).
 * Recipients: active members whose role includes `payments.read` and who can access the project.
 */
export async function runInstallmentReminders(now = new Date()): Promise<number> {
  const today = todayInIndia(now);
  const horizon = parseISODate(addDays(today, env.REMINDER_DAYS_AHEAD));
  const due = await Installment.find({ status: { $in: ['pending', 'partial'] }, dueDate: { $lte: horizon } }, null, { crossTenant: true })
    .limit(5000)
    .lean();
  const bookings = await Booking.find(
    { _id: { $in: [...new Set(due.map((i) => String(i.bookingId)))].map((id) => new Types.ObjectId(id)) } },
    null,
    {
      crossTenant: true,
    },
  )
    .select('bookingNumber status')
    .lean();
  const bookingById = new Map(bookings.map((b) => [String(b._id), b]));

  const byCompany = new Map<string, typeof due>();
  for (const i of due) {
    const b = bookingById.get(String(i.bookingId));
    if (!b || (b.status !== 'booked' && b.status !== 'reserved')) continue;
    const k = String(i.companyId);
    byCompany.set(k, [...(byCompany.get(k) ?? []), i]);
  }

  let created = 0;
  for (const [companyId, items] of byCompany) {
    const cid = new Types.ObjectId(companyId);
    const roles = await Role.find({ companyId: cid, permissions: 'payments.read' }).select('_id').lean();
    const members = await Membership.find({ companyId: cid, status: 'active', roleId: { $in: roles.map((r) => r._id) } }).lean();
    const ops = [];
    for (const inst of items) {
      const overdue = inst.dueDate < parseISODate(today);
      const bookingNumber = bookingById.get(String(inst.bookingId))!.bookingNumber;
      const balance = inst.amountPaise - inst.paidPaise;
      for (const m of members) {
        if (m.projectAccess?.mode === 'restricted' && !m.projectAccess.projectIds?.some((p) => String(p) === String(inst.projectId)))
          continue;
        ops.push({
          updateOne: {
            filter: { userId: m.userId, dedupeKey: `installment:${inst._id}:${today}` },
            update: {
              $setOnInsert: {
                companyId: cid,
                userId: m.userId,
                type: overdue ? 'installment_overdue' : 'installment_due',
                title: overdue ? `Overdue: ${bookingNumber}` : `Due soon: ${bookingNumber}`,
                body: `${inst.name} – ${formatINR(balance)} ${overdue ? 'was due' : 'due'} on ${formatDate(inst.dueDate.toISOString().slice(0, 10))}`,
                link: `/bookings/${inst.bookingId}`,
                dedupeKey: `installment:${inst._id}:${today}`,
              },
            },
            upsert: true,
          },
        });
      }
    }
    if (ops.length) {
      const res = await Notification.bulkWrite(ops, { ordered: false });
      created += res.upsertedCount;
    }
  }
  return created;
}

const tasks: ScheduledTask[] = [];

export function startJobs(): void {
  if (!env.JOBS_ENABLED) return;
  tasks.push(
    cron.schedule(env.RESERVATION_EXPIRY_CRON, async () => {
      try {
        const n = await expireReservations();
        if (n) logger.info({ expired: n }, 'Expired reservations');
      } catch (err) {
        logger.error({ err }, 'Reservation expiry job failed');
      }
    }),
    cron.schedule(env.FOLLOWUP_REMINDER_CRON, async () => {
      try {
        const n = await runFollowUpReminders();
        if (n) logger.info({ created: n }, 'Lead follow-up reminders created');
      } catch (err) {
        logger.error({ err }, 'Follow-up reminder job failed');
      }
    }),
    cron.schedule(env.INSTALLMENT_REMINDER_CRON, async () => {
      try {
        const n = await runInstallmentReminders();
        logger.info({ created: n }, 'Installment reminders created');
      } catch (err) {
        logger.error({ err }, 'Installment reminder job failed');
      }
    }),
  );
  logger.info('Background jobs scheduled');
}

export function stopJobs(): void {
  for (const t of tasks) t.stop();
  tasks.length = 0;
}
