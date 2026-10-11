/**
 * 统一错误码 + AppError
 * 规范见 AGENTS.md 第 6 节：失败响应必须是
 * { success: false, error: { code, message }, meta: { request_id } }
 */

export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  CUSTOMER_NOT_FOUND: 'CUSTOMER_NOT_FOUND',
  LEAD_NOT_FOUND: 'LEAD_NOT_FOUND',
  AGENT_RUN_NOT_FOUND: 'AGENT_RUN_NOT_FOUND',
  INVALID_STATUS_TRANSITION: 'INVALID_STATUS_TRANSITION',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_RATE_LIMIT: 'LLM_RATE_LIMIT',
  LLM_INVALID_OUTPUT: 'LLM_INVALID_OUTPUT',
  LLM_ERROR: 'LLM_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 错误码 → HTTP 状态码 */
export const ERROR_HTTP_STATUS: Record<ErrorCodeValue, number> = {
  VALIDATION_ERROR: 400,
  CUSTOMER_NOT_FOUND: 404,
  LEAD_NOT_FOUND: 404,
  AGENT_RUN_NOT_FOUND: 404,
  INVALID_STATUS_TRANSITION: 409,
  DUPLICATE_RESOURCE: 409,
  LLM_TIMEOUT: 504,
  LLM_RATE_LIMIT: 429,
  LLM_INVALID_OUTPUT: 502,
  LLM_ERROR: 502,
  CONFIG_ERROR: 500,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};

export interface AppErrorOptions {
  /** 附加的排查信息，例如非法状态跳转的 from/to */
  details?: unknown;
  /** 覆盖默认 HTTP 状态码 */
  httpStatus?: number;
  cause?: unknown;
}

export class AppError extends Error {
  public readonly code: ErrorCodeValue;
  public readonly httpStatus: number;
  public readonly details?: unknown;

  constructor(code: ErrorCodeValue, message: string, options: AppErrorOptions = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? ERROR_HTTP_STATUS[code] ?? 500;
    this.details = options.details;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    Error.captureStackTrace?.(this, AppError);
  }
}

export const isAppError = (value: unknown): value is AppError => value instanceof AppError;

/* ------------------------------------------------------------------ */
/* 便捷工厂函数                                                        */
/* ------------------------------------------------------------------ */

export const validationError = (message: string, details?: unknown): AppError =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, { details });

export const customerNotFound = (customerId: number | string): AppError =>
  new AppError(ErrorCode.CUSTOMER_NOT_FOUND, `客户不存在: ${customerId}`, {
    details: { customer_id: customerId },
    httpStatus: 404,
  });

export const leadNotFound = (leadId: number | string): AppError =>
  new AppError(ErrorCode.LEAD_NOT_FOUND, `线索不存在: ${leadId}`, {
    details: { lead_id: leadId },
  });

export const agentRunNotFound = (runId: string): AppError =>
  new AppError(ErrorCode.AGENT_RUN_NOT_FOUND, `Agent 执行记录不存在: ${runId}`, {
    httpStatus: 404,
  });

export const invalidStatusTransition = (from: string, to: string, reason: string): AppError =>
  new AppError(ErrorCode.INVALID_STATUS_TRANSITION, `非法状态跳转: ${from} → ${to}（${reason}）`, {
    details: { from_status: from, to_status: to, reason },
    httpStatus: 409,
  });
