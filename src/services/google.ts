import { OAuth2Client } from 'google-auth-library';

export interface GoogleProfile {
  googleId: string;
  email: string;
  name: string;
}

const clientId = process.env.GOOGLE_CLIENT_ID;
const client = clientId ? new OAuth2Client(clientId) : null;

export const isGoogleConfigured = (): boolean => client !== null;

/**
 * Verifies a Google ID token issued to this app. Returns null on anything
 * unexpected — a wrong audience, a bad signature, or an unverified address —
 * so callers only ever see a profile Google itself vouched for.
 */
export async function verifyGoogleToken(credential: string): Promise<GoogleProfile | null> {
  if (!client || !clientId) return null;

  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();

    // An unverified address could belong to someone else entirely.
    if (!payload?.sub || !payload.email || !payload.email_verified) return null;

    return {
      googleId: payload.sub,
      email: payload.email.toLowerCase(),
      name: payload.name ?? payload.email,
    };
  } catch {
    return null;
  }
}
