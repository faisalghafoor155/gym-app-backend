import { Router, type Response } from 'express';
import auth from '../middleware/auth.js';
import prisma from '../db.js';
import { authed, type AuthedRequest } from '../types.js';
import { askFitnessAi, type AiChatPayload } from '../services/ai.js';

const router = Router();

router.use(auth);

/** How many weigh-ins the coach is shown. Enough for a trend, few enough
 *  that the prompt stays about the question rather than the history. */
const PROGRESS_POINTS = 8;

/**
 * The signed-in member's recent weigh-ins, as prompt lines, or undefined for
 * a staff account or a member who has logged nothing.
 *
 * Read from the session's own member record — the request body cannot name
 * whose history goes into the prompt.
 */
const progressFor = async (req: AuthedRequest<unknown>): Promise<string | undefined> => {
  if (!req.memberId) return undefined;
  const rows = await prisma.memberMeasurement.findMany({
    where: { gymId: req.gymId, memberId: req.memberId },
    orderBy: { measuredOn: 'desc' },
    take: PROGRESS_POINTS,
  });
  if (rows.length === 0) return undefined;
  return rows
    .reverse()
    .map((r) => {
      const parts = [
        r.weightKg && `weight ${r.weightKg.toString()} kg`,
        r.bodyFatPct && `body fat ${r.bodyFatPct.toString()}%`,
        r.chestCm && `chest ${r.chestCm.toString()} cm`,
        r.waistCm && `waist ${r.waistCm.toString()} cm`,
        r.hipsCm && `hips ${r.hipsCm.toString()} cm`,
        r.armCm && `arm ${r.armCm.toString()} cm`,
        r.thighCm && `thigh ${r.thighCm.toString()} cm`,
      ].filter(Boolean);
      return parts.length
        ? `- ${r.measuredOn.toISOString().slice(0, 10)}: ${parts.join(', ')}`
        : null;
    })
    .filter(Boolean)
    .join('\n') || undefined;
};

router.post('/chat', authed(async (req: AuthedRequest<Record<string, string>, unknown, AiChatPayload>, res: Response): Promise<void> => {
  const { message, context, apiKey, lang } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  try {
    // A failed lookup costs the answer some context, not the answer itself.
    const progress = await progressFor(req).catch((err: unknown) => {
      console.error('AI progress lookup failed:', err);
      return undefined;
    });

    const reply = await askFitnessAi({
      message,
      context,
      apiKey: apiKey || (req.headers['x-ai-api-key'] as string | undefined),
      progress,
      lang: lang === 'en' ? 'en' : 'ur',
    });

    res.json({ reply });
  } catch (err) {
    console.error('AI Chat Error:', err);
    res.status(500).json({ error: 'Could not process AI request' });
  }
}));

export default router;
