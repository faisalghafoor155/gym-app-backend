import type { Request, Response, RequestHandler } from 'express';
import type { Role } from '@prisma/client';

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
  role: Role;
  /** Set only when the account belongs to a gym member. */
  memberId: string | null;
}

export interface JwtPayload {
  userId: string;
}

/**
 * Adapts a controller that expects an AuthedRequest into a plain Express
 * RequestHandler. Safe only on routes mounted behind the `auth` middleware,
 * which is what puts the account on the request in the first place.
 */
export const authed =
  <P, ResBody, ReqBody, Q>(
    handler: (req: AuthedRequest<P, ResBody, ReqBody, Q>, res: Response) => unknown,
  ): RequestHandler =>
    (req, res) => {
      void handler(req as unknown as AuthedRequest<P, ResBody, ReqBody, Q>, res);
    };
