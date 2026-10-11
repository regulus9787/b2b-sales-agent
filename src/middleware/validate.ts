/**
 * Zod 校验中间件（AGENTS.md 第 6 节：所有入参必须 Zod 校验）
 * 校验失败 → VALIDATION_ERROR（400），并带上字段级 details。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { AppError, ErrorCode } from '../core/errors';

export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

const toIssues = (error: ZodError): ValidationIssue[] =>
  error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
    code: issue.code,
  }));

export const zodErrorToAppError = (error: ZodError, source: string): AppError =>
  new AppError(ErrorCode.VALIDATION_ERROR, `请求${source}校验失败`, {
    details: { source, issues: toIssues(error) },
    httpStatus: 400,
  });

export type RequestSource = 'body' | 'query' | 'params';

/**
 * 校验并「替换」请求上的对应字段：路由拿到的就是已解析、已带默认值的数据。
 * Express 5 中 req.query 是 getter，因此统一用 defineProperty 覆写为可写属性。
 */
export const validate =
  <T extends ZodTypeAny>(schema: T, source: RequestSource = 'body'): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(zodErrorToAppError(result.error, source));
      return;
    }
    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };

/** 在路由里手动解析（用于路径参数等场景），失败直接抛 VALIDATION_ERROR */
export const parseOrThrow = <T extends ZodTypeAny>(
  schema: T,
  value: unknown,
  source = 'params',
): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw zodErrorToAppError(result.error, source);
  }
  return result.data;
};

export default validate;
