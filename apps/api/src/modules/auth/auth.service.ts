import { Types } from 'mongoose';
import { ALL_PERMISSIONS, type AcceptInviteInput, type AuthContext, type RegisterInput } from '@erp/shared';
import { env } from '../../config/env';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../utils/audit';
import { randomToken, sha256 } from '../../utils/crypto';
import { AppError, badRequest, conflict, notFound, unauthenticated } from '../../utils/errors';
import { sendMail } from '../../utils/mailer';
import { Company } from '../companies/company.model';
import { createCompanyWithDefaults } from '../companies/company.service';
import { Role } from '../roles/role.models';
import { Membership, User } from '../users/user.models';
import { AuthToken, Invitation, Session } from './auth.models';
import { hashPassword, verifyPassword } from './password';
import { signAccessToken } from './tokens';

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 15;
const REFRESH_GRACE_MS = 15_000;

interface ClientMeta {
  ip?: string;
  userAgent?: string;
}

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshExpiresAt: Date;
  sessionId: string;
}

async function issueSession(userId: Types.ObjectId, meta: ClientMeta, activeCompanyId?: Types.ObjectId): Promise<IssuedSession> {
  const refreshToken = randomToken();
  const refreshExpiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
  const session = await Session.create({
    userId,
    tokenHash: sha256(refreshToken),
    activeCompanyId,
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip,
    expiresAt: refreshExpiresAt,
    lastUsedAt: new Date(),
  });
  const access = signAccessToken(String(userId), String(session._id));
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken,
    refreshExpiresAt,
    sessionId: String(session._id),
  };
}

async function createAuthToken(userId: Types.ObjectId, type: 'verify_email' | 'reset_password', ttlMs: number): Promise<string> {
  const token = randomToken();
  await AuthToken.create({ userId, type, tokenHash: sha256(token), expiresAt: new Date(Date.now() + ttlMs) });
  return token;
}

async function sendVerificationEmail(user: { _id: Types.ObjectId; email: string; name: string }) {
  const token = await createAuthToken(user._id, 'verify_email', 48 * 3600_000);
  await sendMail({
    to: user.email,
    subject: 'Verify your email address',
    text: `Hello ${user.name},\n\nPlease verify your email address:\n${env.APP_URL}/verify-email?token=${token}\n\nThis link expires in 48 hours.`,
  });
}

export async function register(input: RegisterInput, meta: ClientMeta) {
  const existing = await User.exists({ email: input.email });
  if (existing) throw conflict('An account with this email already exists');
  const passwordHash = await hashPassword(input.password);

  const { user, company } = await withTransaction(async (session) => {
    const [user] = await User.create([{ name: input.name, email: input.email, passwordHash }], { session });
    const company = await createCompanyWithDefaults({ name: input.companyName, ownerUserId: user!._id }, session);
    await audit(
      { companyId: company._id, userId: user!._id, meta },
      { action: 'auth.register', entityType: 'user', entityId: user!._id, summary: `Registered and created ${company.name}` },
      session,
    );
    return { user: user!, company };
  });

  await sendVerificationEmail(user);
  return issueSession(user._id, meta, company._id);
}

export async function login(email: string, password: string, meta: ClientMeta): Promise<IssuedSession> {
  const user = await User.findOne({ email }).select('+passwordHash');
  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many failed attempts. Try again in a few minutes.');
  }
  const valid = await verifyPassword(user?.passwordHash, password);
  if (!user || !valid || !user.isActive) {
    if (user) {
      const failed = (user.failedLoginCount ?? 0) + 1;
      user.failedLoginCount = failed >= MAX_FAILED_LOGINS ? 0 : failed;
      if (failed >= MAX_FAILED_LOGINS) user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60_000);
      await user.save();
    }
    await audit(null, { action: 'auth.login_failed', entityType: 'user', entityId: user?._id, summary: email });
    throw unauthenticated('Invalid email or password');
  }

  user.failedLoginCount = 0;
  user.lockedUntil = undefined;
  user.lastLoginAt = new Date();
  await user.save();

  // Auto-select the company when the user belongs to exactly one.
  const memberships = await Membership.find({ userId: user._id, status: 'active' }, null, { crossTenant: true }).select('companyId').lean();
  const activeCompanyId = memberships.length === 1 ? memberships[0]!.companyId : undefined;
  const issued = await issueSession(user._id, meta, activeCompanyId);
  await audit(
    { companyId: activeCompanyId!, userId: user._id, meta },
    { action: 'auth.login', entityType: 'session', entityId: new Types.ObjectId(issued.sessionId) },
  );
  return issued;
}

/** Rotates the refresh token. Atomic: concurrent refreshes cannot both succeed. */
export async function refresh(refreshToken: string | undefined, meta: ClientMeta): Promise<IssuedSession> {
  if (!refreshToken) throw unauthenticated('No session');
  const hash = sha256(refreshToken);
  const newToken = randomToken();
  const now = new Date();

  const session = await Session.findOneAndUpdate(
    { tokenHash: hash, revokedAt: null, expiresAt: { $gt: now } },
    { $set: { tokenHash: sha256(newToken), previousTokenHash: hash, rotatedAt: now, lastUsedAt: now, ip: meta.ip } },
    { new: true },
  );

  if (!session) {
    const reused = await Session.findOne({ previousTokenHash: hash });
    if (reused && !reused.revokedAt) {
      if (reused.rotatedAt && now.getTime() - reused.rotatedAt.getTime() < REFRESH_GRACE_MS) {
        // Another tab refreshed a moment ago; the browser already holds the new cookie.
        throw new AppError(409, 'CONFLICT', 'Session was just refreshed. Retry the request.');
      }
      reused.revokedAt = now;
      reused.revokedReason = 'refresh_token_reuse';
      await reused.save();
      await audit(
        { companyId: reused.activeCompanyId!, userId: reused.userId, meta },
        { action: 'auth.refresh_reuse_detected', entityType: 'session', entityId: reused._id },
      );
    }
    throw unauthenticated('Session expired. Please sign in again.');
  }

  const user = await User.findById(session.userId).select('isActive').lean();
  if (!user?.isActive) {
    session.revokedAt = now;
    session.revokedReason = 'user_disabled';
    await session.save();
    throw unauthenticated('Account is disabled');
  }

  const access = signAccessToken(String(session.userId), String(session._id));
  return {
    accessToken: access.token,
    accessTokenExpiresAt: access.expiresAt,
    refreshToken: newToken,
    refreshExpiresAt: session.expiresAt,
    sessionId: String(session._id),
  };
}

export async function revokeSessionByToken(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await Session.updateOne(
    { tokenHash: sha256(refreshToken), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'logout' } },
  );
}

export async function listSessions(userId: string, currentSessionId: string) {
  const sessions = await Session.find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .select('userAgent ip createdAt lastUsedAt expiresAt')
    .sort({ lastUsedAt: -1 })
    .lean();
  return sessions.map((s) => ({
    id: String(s._id),
    userAgent: s.userAgent,
    ip: s.ip,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    current: String(s._id) === currentSessionId,
  }));
}

export async function revokeSession(userId: string, sessionId: string) {
  const res = await Session.updateOne(
    { _id: sessionId, userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'user_revoked' } },
  );
  if (res.matchedCount === 0) throw notFound('Session');
}

export async function revokeAllSessions(userId: Types.ObjectId | string, reason: string, exceptSessionId?: string) {
  await Session.updateMany(
    { userId, revokedAt: null, ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}) },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
}

export async function selectCompany(userId: string, sessionId: string, companyId: string) {
  const membership = await Membership.findOne({ companyId: new Types.ObjectId(companyId), userId, status: 'active' }).lean();
  // 404 rather than 403: do not reveal whether a company exists.
  if (!membership) throw notFound('Company');
  await Session.updateOne({ _id: sessionId, userId }, { $set: { activeCompanyId: membership.companyId } });
}

export async function getAuthContext(userId: string, activeCompanyId?: string): Promise<AuthContext> {
  const user = await User.findById(userId).lean();
  if (!user) throw unauthenticated();
  const memberships = await Membership.find({ userId: user._id, status: 'active' }, null, { crossTenant: true }).lean();
  const companies = await Company.find({ _id: { $in: memberships.map((m) => m.companyId) }, isActive: true })
    .select('name')
    .lean();
  const roles = await Role.find({ _id: { $in: memberships.map((m) => m.roleId) } }, null, { crossTenant: true })
    .select('name permissions systemKey')
    .lean();

  const summaries = memberships
    .map((m) => {
      const company = companies.find((c) => String(c._id) === String(m.companyId));
      const role = roles.find((r) => String(r._id) === String(m.roleId));
      if (!company || !role) return null;
      return { id: String(company._id), name: company.name, roleName: role.name, membership: m, role };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const active = summaries.find((s) => s.id === activeCompanyId) ?? null;
  return {
    user: { id: String(user._id), name: user.name, email: user.email, emailVerified: Boolean(user.emailVerifiedAt) },
    companies: summaries.map(({ id, name, roleName }) => ({ id, name, roleName })),
    activeCompany: active
      ? {
          id: active.id,
          name: active.name,
          roleName: active.roleName,
          permissions: active.role.systemKey === 'owner' ? ALL_PERMISSIONS : active.role.permissions,
          projectAccess: {
            mode: active.membership.projectAccess?.mode === 'restricted' ? 'restricted' : 'all',
            projectIds: (active.membership.projectAccess?.projectIds ?? []).map(String),
          },
        }
      : null,
  };
}

export async function verifyEmail(token: string) {
  const record = await AuthToken.findOneAndUpdate(
    { tokenHash: sha256(token), type: 'verify_email', usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  if (!record) throw badRequest('This verification link is invalid or has expired');
  await User.updateOne({ _id: record.userId }, { $set: { emailVerifiedAt: new Date() } });
}

export async function resendVerification(userId: string) {
  const user = await User.findById(userId).lean();
  if (!user || user.emailVerifiedAt) return;
  await sendVerificationEmail(user);
}

export async function forgotPassword(email: string) {
  const user = await User.findOne({ email, isActive: true }).lean();
  // Always respond the same way so attackers cannot enumerate accounts.
  if (!user) return;
  const token = await createAuthToken(user._id, 'reset_password', 3600_000);
  await sendMail({
    to: user.email,
    subject: 'Reset your password',
    text: `Hello ${user.name},\n\nReset your password using this link (valid for 1 hour):\n${env.APP_URL}/reset-password?token=${token}\n\nIf you did not request this, ignore this email.`,
  });
}

export async function resetPassword(token: string, password: string, meta: ClientMeta) {
  const record = await AuthToken.findOneAndUpdate(
    { tokenHash: sha256(token), type: 'reset_password', usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
  );
  if (!record) throw badRequest('This reset link is invalid or has expired');
  const passwordHash = await hashPassword(password);
  await User.updateOne({ _id: record.userId }, { $set: { passwordHash, failedLoginCount: 0 }, $unset: { lockedUntil: 1 } });
  await revokeAllSessions(record.userId, 'password_reset');
  await audit(null, { action: 'auth.password_reset', entityType: 'user', entityId: record.userId, summary: meta.ip });
}

export async function changePassword(userId: string, sessionId: string, current: string, next: string) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user || !(await verifyPassword(user.passwordHash, current))) throw badRequest('Current password is incorrect');
  user.passwordHash = await hashPassword(next);
  await user.save();
  await revokeAllSessions(user._id, 'password_changed', sessionId);
}

export async function describeInvitation(token: string) {
  const inv = await Invitation.findOne({ tokenHash: sha256(token), status: 'pending', expiresAt: { $gt: new Date() } }, null, {
    crossTenant: true,
  }).lean();
  if (!inv) throw notFound('Invitation');
  const company = await Company.findById(inv.companyId).select('name').lean();
  const userExists = Boolean(await User.exists({ email: inv.email }));
  return { email: inv.email, companyName: company?.name ?? '', userExists };
}

/**
 * Accept an invitation. New users set a name and password here. Existing users must be
 * signed in as the invited email address (`currentUserId`).
 */
export async function acceptInvitation(input: AcceptInviteInput, currentUserId: string | undefined, meta: ClientMeta) {
  const inv = await Invitation.findOne({ tokenHash: sha256(input.token), status: 'pending', expiresAt: { $gt: new Date() } }, null, {
    crossTenant: true,
  });
  if (!inv) throw notFound('Invitation');

  const existing = await User.findOne({ email: inv.email }).select('_id').lean();
  let userId: Types.ObjectId | undefined = existing?._id;
  let issued: IssuedSession | null = null;

  await withTransaction(async (session) => {
    if (userId) {
      if (!currentUserId || String(userId) !== currentUserId) {
        throw new AppError(401, 'UNAUTHENTICATED', `Sign in as ${inv.email} to accept this invitation`);
      }
    } else {
      if (!input.name || !input.password) throw badRequest('Name and password are required to create your account');
      const passwordHash = await hashPassword(input.password);
      // The invite link was delivered to this mailbox, which verifies the address.
      const [created] = await User.create([{ name: input.name, email: inv.email, passwordHash, emailVerifiedAt: new Date() }], { session });
      userId = created!._id;
    }
    await Membership.findOneAndUpdate(
      { companyId: inv.companyId, userId },
      { $set: { roleId: inv.roleId, status: 'active', projectAccess: inv.projectAccess, invitedBy: inv.invitedBy } },
      { upsert: true, session },
    );
    inv.status = 'accepted';
    inv.acceptedAt = new Date();
    await inv.save({ session });
    await audit(
      { companyId: inv.companyId, userId: userId!, meta },
      { action: 'users.invitation_accepted', entityType: 'membership', entityId: userId, summary: inv.email },
      session,
    );
  });

  if (!currentUserId) issued = await issueSession(userId!, meta, inv.companyId);
  return { issued, companyId: String(inv.companyId) };
}
