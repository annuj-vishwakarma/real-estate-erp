import type { NextFunction, Request, Response } from 'express';
import { Types } from 'mongoose';
import { ALL_PERMISSIONS, type Permission } from '@erp/shared';
import { Membership, User } from '../modules/users/user.models';
import { Role } from '../modules/roles/role.models';
import { Session } from '../modules/auth/auth.models';
import { verifyAccessToken } from '../modules/auth/tokens';
import { AppError, forbidden, unauthenticated } from '../utils/errors';

/** Verifies the bearer access token and that its session is still live. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthenticated();
  const payload = verifyAccessToken(header.slice(7));

  // Revocation is immediate: a revoked/expired session invalidates its access tokens.
  const session = await Session.findById(payload.sid).select('userId revokedAt expiresAt activeCompanyId').lean();
  if (!session || session.revokedAt || session.expiresAt < new Date() || String(session.userId) !== payload.sub) {
    throw new AppError(401, 'UNAUTHENTICATED', 'Session has ended. Please sign in again.');
  }
  const user = await User.findById(payload.sub).select('isActive').lean();
  if (!user?.isActive) throw unauthenticated('Account is disabled');

  req.auth = {
    userId: payload.sub,
    sessionId: payload.sid,
    companyId: session.activeCompanyId ? String(session.activeCompanyId) : undefined,
  };
  next();
}

/**
 * Establishes the tenant context from the server-side session (never from client input):
 * verifies active membership in the selected company and loads role permissions.
 */
export async function tenant(req: Request, _res: Response, next: NextFunction) {
  if (!req.auth) throw unauthenticated();
  if (!req.auth.companyId) throw new AppError(403, 'FORBIDDEN', 'Select a company to continue');

  const companyId = new Types.ObjectId(req.auth.companyId);
  const userId = new Types.ObjectId(req.auth.userId);
  const membership = await Membership.findOne({ companyId, userId, status: 'active' }).lean();
  if (!membership) throw forbidden('You are not an active member of this company');
  const role = await Role.findOne({ companyId, _id: membership.roleId }).select('permissions systemKey').lean();
  if (!role) throw forbidden('Your role no longer exists');

  req.ctx = {
    userId,
    companyId,
    roleId: role._id,
    // The owner role always carries the full, current catalog (including newly added permissions).
    permissions: new Set(role.systemKey === 'owner' ? ALL_PERMISSIONS : role.permissions),
    projectScope: membership.projectAccess?.mode === 'restricted' ? (membership.projectAccess.projectIds ?? []) : null,
    meta: { ip: req.ip, userAgent: req.get('user-agent'), requestId: String(req.id) },
  };
  next();
}

/** Requires every listed permission. */
export function authorize(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ctx = req.ctx;
    if (!ctx) throw unauthenticated();
    for (const p of permissions) if (!ctx.permissions.has(p)) throw forbidden();
    next();
  };
}
