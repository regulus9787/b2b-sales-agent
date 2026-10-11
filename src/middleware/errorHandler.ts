/**
 * 全局错误处理（AGENTS.md 第 6 节）
 * 所有异常统一转成 { success:false, error:{code,message}, meta:{request_id} }
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError, ErrorCode, isAppError } from '../core/errors';
import { failureBody } from './response';
import { logger } from './logger';
import { zodErrorToAppError } from './validate';

export const notFoundHandler = (req: Request, res: Response): void => {
  const requestId = res.locals.requestId ?? 'unknown';
  res
    .status(404)
    .json(
      failureBody(ErrorCode.NOT_FOUND, `接口不存在: ${req.method} ${req.originalUrl}`, requestId),
    );
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export const errorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  const requestId = res.locals.requestId ?? req.requestId ?? 'unknown';

  const appError: AppError = isAppError(err)
    ? err
    : err instanceof ZodError
      ? zodErrorToAppError(err, 'body')
      : new AppError(ErrorCode.INTERNAL_ERROR, err instanceof Error ? err.message : '未知错误', {
          cause: err,
        });

  const status = appError.httpStatus;
  const logPayload = {
    request_id: requestId,
    method: req.method,
    path: req.originalUrl,
    status,
    code: appError.code,
    message: appError.message,
    details: appError.details,
  };

  if (status >= 500) {
    logger.error({ ...logPayload, err }, 'request failed');
  } else {
    logger.warn(logPayload, 'request rejected');
  }

  if (res.headersSent) return;

  res
    .status(status)
    .json(failureBody(appError.code, appError.message, requestId, appError.details));
};

export default errorHandler;
