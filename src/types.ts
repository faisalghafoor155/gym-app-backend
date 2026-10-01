/** @format */

import type { Request, Response, RequestHandler } from "express";
import type { Role, StaffPermission } from "@prisma/client";

/**
 * The auth middleware attaches the signed-in account to every authenticated
 * request. Routes behind `auth` receive this instead of a bare Request.
 */
export interface AuthedRequest<
  Params = Record<string, string>,
  ResBody = unknown,
  ReqBody = unknown,
  Query = Record<string, unknown>,
> extends Request<Params, ResBody, ReqBody, Query> {
  gymId: string;
  userId: string;
  userEmail?: string;
  role: Role;
  /** Staff permission level (only set when role is 'staff') */
  staffPermission?: StaffPermission;
  /** The actor's display name, carried so audit entries can copy it in
   *  without a second lookup on every mutation. */
  actorName: string;
  /** Set only when the account belongs to a gym member. */
  memberId: string | null;
}

export interface JwtPayload {
  userId: string;
  /**
   * The account's `tokenVersion` at the moment this token was signed. The auth
   * middleware rejects the token once the stored version moves past it.
   */
  tokenVersion: number;
  /**
   * Set only on tokens that are not sessions — e.g. the short-lived 2FA login
   * challenge. The auth middleware refuses any token carrying one, so a
   * challenge can never stand in for a session.
   */
  purpose?: string;
}

/**
 * Adapts a controller that expects an AuthedRequest into a plain Express
 * RequestHandler. Safe only on routes mounted behind the `auth` middleware,
 * which is what puts the account on the request in the first place.
 */
export const authed =
  <P, ResBody, ReqBody, Q>(
    handler: (
      req: AuthedRequest<P, ResBody, ReqBody, Q>,
      res: Response,
    ) => unknown,
  ): RequestHandler =>
  (req, res) => {
    void handler(req as unknown as AuthedRequest<P, ResBody, ReqBody, Q>, res);
  };
