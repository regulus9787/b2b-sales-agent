/**
 * 共享类型定义（src/types 目录用于跨层类型，领域枚举在 src/core）
 */

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  meta: ApiMeta;
}

export interface ApiMeta {
  request_id: string;
  [key: string]: unknown;
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: PaginationMeta;
}

/** LLM 提供商（OpenAI 兼容接口） */
export type LlmProvider = 'deepseek' | 'openai' | 'doubao' | 'mock' | 'custom';

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LlmCallRecord {
  id: number;
  run_id: string | null;
  provider: string;
  model: string;
  operation: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  cost_usd: number;
  status: 'success' | 'error' | 'fallback';
  attempt: number;
  mock: number;
  error: string | null;
  created_at: string;
}

export interface HttpLogFields {
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  request_id: string;
}
