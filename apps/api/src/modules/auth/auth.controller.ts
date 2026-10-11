import type { Request, Response } from 'express';
import {
  ChangePasswordRequestSchema,
  LoginRequestSchema,
  PreLoginRequestSchema,
  SwitchBranchRequestSchema,
  type AccessTokenResponse,
  type AuthBranchListResponse,
  type PreLoginResponse,
  type ProfileResponse,
} from '@bms/shared';
import { AppError, AuthError, ServiceUnavailableError } from '../../lib/errors.js';
import { setCsrfCookie } from '../../middleware/csrf.js';
import { valid } from '../../middleware/validate.js';
import { ACCESS_TOKEN_SECONDS } from './auth.policy.js';
import * as service from './auth.service.js';

/**
 * HTTP side of signing in (A3): validated request -> service -> response.
 * The refresh token lives only in the httpOnly `refreshToken` cookie.
 */

export const schemas = {
  preLogin: { body: PreLoginRequestSchema },
  login: { body: LoginRequestSchema },
  switchBranch: { body: SwitchBranchRequestSchema },
  changePassword: { body: ChangePasswordRequestSchema },
};

const REFRESH_COOKIE = 'refreshToken';

/** The cookie lasts as long as the session (at most one shift). */
function setRefreshCookie(res: Response, token: string, sessionExpiresAt: Date): void {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.max(0, sessionExpiresAt.getTime() - Date.now()),
  });
}

function signedIn(req: Request) {
  const { staffId, sessionId, branchId, role, roles } = req.staff!;
  return { staffId, sessionId, branchId, role, roles: roles ?? [role] };
}

export async function preLogin(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.preLogin);
  let result: PreLoginResponse;
  try {
    result = await service.preLogin(body.username, body.password);
  } catch (err) {
    // The sign-in page shows "try again" for a 503, not a server error.
    if (err instanceof AppError) throw err;
    throw new ServiceUnavailableError();
  }
  res.json(result);
}

export async function login(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.login);
  const issued = await service.login(body.username, body.password, body.branchId);
  setRefreshCookie(res, issued.refreshToken!, issued.sessionExpiresAt);
  const result: AccessTokenResponse = {
    accessToken: issued.accessToken,
    expiresIn: ACCESS_TOKEN_SECONDS,
    mustChangePassword: issued.mustChangePassword,
    csrfToken: setCsrfCookie(res),
  };
  res.json(result);
}

export async function refresh(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[REFRESH_COOKIE] as string | undefined;
  if (!token) throw new AuthError('MISSING_REFRESH_TOKEN', 'Refresh token required');
  let issued;
  try {
    issued = await service.refresh(token);
  } catch (err) {
    if (err instanceof AppError && err.code === 'TOKEN_REVOKED') res.clearCookie(REFRESH_COOKIE);
    throw err;
  }
  if (issued.refreshToken) setRefreshCookie(res, issued.refreshToken, issued.sessionExpiresAt);
  const result: AccessTokenResponse = {
    accessToken: issued.accessToken,
    expiresIn: ACCESS_TOKEN_SECONDS,
    mustChangePassword: issued.mustChangePassword,
    csrfToken: setCsrfCookie(res),
  };
  res.json(result);
}

export async function logout(req: Request, res: Response): Promise<void> {
  const { staffId, sessionId } = signedIn(req);
  await service.logout(staffId, sessionId);
  res.clearCookie(REFRESH_COOKIE);
  res.json({ message: 'Logged out successfully' });
}

export async function switchBranch(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.switchBranch);
  const { accessToken } = await service.switchBranch(signedIn(req), body.branchId);
  const result: AccessTokenResponse = {
    accessToken,
    expiresIn: ACCESS_TOKEN_SECONDS,
    mustChangePassword: false,
    csrfToken: setCsrfCookie(res),
  };
  res.json(result);
}

export async function branches(req: Request, res: Response): Promise<void> {
  const result: AuthBranchListResponse = { branches: await service.branchesOf(req.staff!.staffId, req.scope!.allBranches) };
  res.json(result);
}

export async function profile(req: Request, res: Response): Promise<void> {
  const result: ProfileResponse = await service.profile(signedIn(req));
  res.json(result);
}

export async function changePassword(req: Request, res: Response): Promise<void> {
  const { body } = valid(req, schemas.changePassword);
  await service.changePassword(signedIn(req), body.currentPassword, body.newPassword);
  res.json({ message: 'Password updated successfully' });
}
