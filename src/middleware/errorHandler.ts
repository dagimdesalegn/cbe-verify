import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../utils/logger';

export function errorHandler(err: any, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(422).json({
      success: false,
      message: 'Invalid payload',
      errors: err.issues ?? (err as any).errors,
    });
  }
  logger.error({ err });
  const status = err?.status ?? 500;
  return res.status(status).json({
    success: false,
    message: err?.message ?? 'Internal server error',
  });
}