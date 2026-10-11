/**
 * API 客户端：axios 实例 + 统一响应信封解包
 * 开发环境通过 Vite proxy 把 /api 代理到 http://localhost:3000
 */
import axios, { AxiosError, type AxiosInstance } from 'axios';

/** 统一响应信封（AGENTS.md 第 6 节） */
export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: { request_id: string; [key: string]: unknown };
}

export interface ApiFailure {
  success: false;
  error: { code: string; message: string; details?: unknown };
  meta: { request_id: string };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;
  readonly requestId?: string;

  constructor(params: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details;
    this.requestId = params.requestId;
  }
}

const baseURL = import.meta.env.VITE_API_BASE_URL ?? '';

export const http: AxiosInstance = axios.create({
  baseURL,
  timeout: 120000,
  headers: { 'Content-Type': 'application/json' },
});

/** 解包统一信封：失败时抛 ApiError */
const unwrap = <T>(payload: ApiResponse<T> | T): T => {
  if (payload && typeof payload === 'object' && 'success' in (payload as object)) {
    const envelope = payload as ApiResponse<T>;
    if (envelope.success) return envelope.data;
    throw new ApiError({
      code: envelope.error.code,
      message: envelope.error.message,
      status: 200,
      details: envelope.error.details,
      requestId: envelope.meta?.request_id,
    });
  }
  return payload as T;
};

http.interceptors.response.use(
  (response) => response,
  (error: AxiosError<ApiFailure>) => {
    const status = error.response?.status ?? 0;
    const body = error.response?.data;
    if (body && typeof body === 'object' && 'error' in body) {
      return Promise.reject(
        new ApiError({
          code: body.error.code,
          message: body.error.message,
          status,
          details: body.error.details,
          requestId: body.meta?.request_id,
        }),
      );
    }
    return Promise.reject(
      new ApiError({
        code: status === 0 ? 'NETWORK_ERROR' : 'HTTP_ERROR',
        message: error.message || '请求失败',
        status,
      }),
    );
  },
);

export const api = {
  get: async <T>(url: string, params?: Record<string, unknown>): Promise<T> => {
    const response = await http.get<ApiResponse<T>>(url, { params });
    return unwrap<T>(response.data);
  },
  post: async <T>(url: string, body?: unknown): Promise<T> => {
    const response = await http.post<ApiResponse<T>>(url, body ?? {});
    return unwrap<T>(response.data);
  },
};

export default api;
