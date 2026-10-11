/**
 * 统一响应信封（AGENTS.md 第 6 节）
 *   成功: { success: true,  data,   meta: { request_id } }
 *   失败: { success: false, error: { code, message }, meta: { request_id } }
 */
import type { Response } from 'express';
import type { ApiFailure, ApiMeta, ApiSuccess } from '../types';
import { AppError, ERROR_HTTP_STATUS, ErrorCode, isAppError } from '../core/errors';

export const buildMeta = (requestId: string, extra?: Record<string, unknown>): ApiMeta => ({
  request_id: requestId,
  ...(extra ?? {}),
});

export const successBody = <T>(
  data: T,
  requestId: string,
  extraMeta?: Record<string, unknown>,
): ApiSuccess<T> => ({
  success: true,
  data,
  meta: buildMeta(requestId, extraMeta),
});

export const failureBody = (
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): ApiFailure => ({
  success: false,
  error: { code, message, ...(details === undefined ? {} : { details }) },
  meta: buildMeta(requestId),
});

/** 成功响应：res.ok(data) —— 自动带上 request_id */
export const ok = <T>(res: Response, data: T, extraMeta?: Record<string, unknown>): Response => {
  const requestId = res.locals.requestId ?? 'unknown';
  return res.status(200).json(successBody(data, requestId, extraMeta));
};

/** 创建成功响应（201） */
export const created = <T>(
  res: Response,
  data: T,
  extraMeta?: Record<string, unknown>,
): Response => {
  const requestId = res.locals.requestId ?? 'unknown';
  return res.status(201).json(successBody(data, requestId, extraMeta));
};

/** 失败响应；传入 AppError 时自动取错误码与状态码 */
export const fail = (res: Response, error: unknown): Response => {
  const requestId = res.locals.requestId ?? 'unknown';
  if (isAppError(error)) {
    return res
      .status(error.httpStatus)
      .json(failureBody(error.code, error.message, requestId, error.details));
  }
  if (error instanceof Error) {
    return res
      .status(ERROR_HTTP_STATUS[ErrorCode.INTERNAL_ERROR])
      .json(failureBody(ErrorCode.INTERNAL_ERROR, error.message, requestId));
  }
  return res
    .status(ERROR_HTTP_STATUS[ErrorCode.INTERNAL_ERROR])
    .json(failureBody(ErrorCode.INTERNAL_ERROR, '未知错误', requestId));
};

export const assertAppError = (error: unknown): AppError =>
  isAppError(error) ? error : new AppError(ErrorCode.INTERNAL_ERROR, String(error));
