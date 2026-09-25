import { Router, type Response } from 'express';
import auth from '../middleware/auth.js';
import { authed, type AuthedRequest } from '../types.js';
import { askFitnessAi, type AiChatPayload } from '../services/ai.js';

const router = Router();

router.use(auth);

router.post('/chat', authed(async (req: AuthedRequest<Record<string, string>, unknown, AiChatPayload>, res: Response): Promise<void> => {
  const { message, context, apiKey } = req.body;

  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  try {
    const reply = await askFitnessAi({
      message,
      context,
      apiKey: apiKey || (req.headers['x-ai-api-key'] as string | undefined),
    });

    res.json({ reply });
  } catch (err) {
    console.error('AI Chat Error:', err);
    res.status(500).json({ error: 'Could not process AI request' });
  }
}));

export default router;
