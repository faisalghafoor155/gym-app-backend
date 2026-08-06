import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ZodType } from 'zod';

type Source = 'body' | 'params' | 'query';

/**
 * Validates req.body / req.params / req.query against a Zod schema and replaces
 * the request value with the parsed result, so controllers receive coerced,
 * trusted data (numbers as numbers, dates as Dates) and can drop their own
 * parseFloat/parseInt calls.
 */
const validate = (schema: ZodType, source: Source = 'body'): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      // Surface the first problem only — the UI shows one message at a time.
      const issue = result.error.issues[0]!;
      const path = issue.path.join('.');
      res.status(400).json({ error: path ? `${path}: ${issue.message}` : issue.message });
      return;
    }
    // Express 5 makes req.query a getter-only property, so assign through
    // defineProperty rather than plain assignment.
    Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true });
    next();
  };

export default validate;
