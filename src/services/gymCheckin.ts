import jwt from 'jsonwebtoken';

/**
 * The token behind the gym's own check-in QR.
 *
 * The desk screen shows a QR that changes every few seconds; a member scans it
 * with their phone and the phone's signed-in session says who they are. The
 * token only says *which gym* and *that it is fresh* — it identifies nobody,
 * so on its own it checks nobody in.
 *
 * Short-lived so a photo of the screen taken home stops working within a
 * couple of minutes. Longer than the on-screen rotation, though, because a
 * member who scans and then has to sign in first needs time to type a
 * password before the code they scanned runs out.
 *
 * Carries a `purpose`, which the auth middleware refuses outright, so it can
 * never be passed off as a session.
 */
export const GYM_CHECKIN_PURPOSE = 'gym-checkin' as const;
export const GYM_CHECKIN_TTL_SECONDS = 120;
/** How often the desk asks for a new code. */
export const GYM_CHECKIN_ROTATE_SECONDS = 30;

export const signGymCheckinToken = (gymId: string): string =>
  jwt.sign({ gymId, purpose: GYM_CHECKIN_PURPOSE }, process.env.JWT_SECRET!, {
    expiresIn: GYM_CHECKIN_TTL_SECONDS,
  });

/** The gym a token was issued for, or null if it is malformed, expired or not one of ours. */
export const verifyGymCheckinToken = (token: string): string | null => {
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      gymId?: unknown;
      purpose?: unknown;
    };
    if (payload.purpose !== GYM_CHECKIN_PURPOSE || typeof payload.gymId !== 'string') return null;
    return payload.gymId;
  } catch {
    return null;
  }
};
