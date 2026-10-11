/**
 * LLM 网关（AGENTS.md 第 5 节）—— 全项目唯一的 LLM 出口
 *
 * 必须具备：
 *  - 超时：AbortController，默认 30s（LLM_TIMEOUT_MS）
 *  - 重试：指数退避，最多 3 次，仅对 429 / 5xx / 网络错误重试
 *  - 限流：识别 429，读取 Retry-After（秒或 HTTP 日期）
 *  - 输出校验：由调用方用 Zod 校验（本文件提供 JSON 抽取辅助）
 *  - 降级：失败抛出明确错误码（LLM_TIMEOUT / LLM_RATE_LIMIT / LLM_ERROR / LLM_INVALID_OUTPUT）
 *  - Token 统计 + 成本估算：每次调用写 llm_calls
 *  - Mock 模式：LLM_API_KEY 为空时使用确定性 Mock，保证项目可演示
 */
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import config from '../config';
import { AppError, ErrorCode } from '../core/errors';
import { logger } from '../middleware/logger';
import { logLlmCall, type LlmCallLogInput } from './llm-log';
import { estimateCostUsd, estimateTokensFromText } from './pricing';
import { mockLlm } from './llm-mock';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type LlmOperation = 'generate_email' | 'classify_intent' | 'suggest_next_action' | string;

export interface LlmCallOptions {
  /** 逻辑操作名，用于 llm_calls.operation 与 Mock 路由 */
  operation: LlmOperation;
  messages: LlmMessage[];
  /** 要求返回严格 JSON（会设置 response_format） */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** 关联的 Agent run_id */
  runId?: string | null;
  /** 写 llm_calls 的数据库连接；不传则只记录日志 */
  db?: Database;
  /** 测试钩子：注入自定义 fetch */
  fetchImpl?: typeof fetch;
  /** 测试钩子：覆盖 Mock 模式（默认取配置） */
  mock?: boolean;
  /** 测试钩子：覆盖 API Key（默认取配置） */
  apiKey?: string;
  /** 请求标签，便于日志排查 */
  label?: string;
}

export interface LlmUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface LlmCallResult<T = string> {
  content: string;
  /** 已按 operation 的解析器处理后的结果 */
  data: T;
  usage: LlmUsage;
  cost_usd: number;
  latency_ms: number;
  model: string;
  provider: string;
  mock: boolean;
  attempts: number;
  /** 是否走了降级路径（LLM 失败但被降级处理） */
  fallback: boolean;
  error?: string | null;
}

/** 已知的 LLM 操作名（用于文档与前端展示） */
export const LLM_OPERATIONS = ['generate_email', 'classify_intent', 'suggest_next_action'] as const;
export type KnownLlmOperation = (typeof LLM_OPERATIONS)[number];

/** 判断是否可重试：429 / 5xx / 网络错误 */
export const isRetryableStatus = (status: number): boolean => status === 429 || status >= 500;

/**
 * 解析 Retry-After 头：支持秒数（"2"）与 HTTP 日期（"Wed, 21 Oct 2025 07:28:00 GMT"）
 * 返回毫秒数；无法解析时返回 null。
 */
export const parseRetryAfter = (value: string | null, now: number = Date.now()): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, parsed - now);
};

/** 指数退避：base * 2^(attempt-1)，并加 0~250ms 抖动，上限 30s */
export const backoffDelayMs = (attempt: number, baseMs = 500, jitter = 250): number => {
  const raw = baseMs * 2 ** (attempt - 1);
  const withJitter = raw + Math.floor(Math.random() * jitter);
  return Math.min(withJitter, 30000);
};

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, ms));
  });

/**
 * 从 LLM 输出中抽取 JSON（容忍 ```json 代码块、前后解释文字）。
 * 返回解析后的对象；解析失败返回 null。
 */
export const extractJsonObject = (content: string): unknown => {
  const text = content.trim();

  const candidates: string[] = [];
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) candidates.push(fenceMatch[1].trim());

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1));
  }
  candidates.push(text);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
};

interface OpenAiChatResponse {
  id?: string;
  model?: string;
  choices?: { message?: { role?: string; content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

const buildHeaders = (apiKey: string): Record<string, string> => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${apiKey}`,
});

/**
 * 思考模式参数（DeepSeek 特有）
 * - DeepSeek 的 thinking 默认是 enabled，会先输出思维链 reasoning_content 再给 content；
 *   本项目只消费 content，且意图分类要求严格 JSON，因此默认显式 disabled：
 *   既省输出 token（思维链按输出计费），也避免思维链干扰 JSON 抽取。
 * - OpenAI / 豆包等不支持该参数的提供商：disabled 时不发送，避免请求被拒。
 */
const buildThinkingField = (): Record<string, unknown> => {
  const thinking = config.llm.thinking;
  const isDeepSeek = config.llm.provider === 'deepseek' || /deepseek/i.test(config.llm.baseUrl);

  if (!isDeepSeek) {
    return thinking === 'enabled' ? { thinking: { type: 'enabled' } } : {};
  }
  if (thinking === 'enabled') {
    return { thinking: { type: 'enabled' } };
  }
  if (thinking === 'disabled') {
    return { thinking: { type: 'disabled' } };
  }
  // minimal / low / high / max：开启思考并用 reasoning_effort 控制强度
  return { thinking: { type: 'enabled' }, reasoning_effort: thinking };
};

const buildPayload = (options: LlmCallOptions): Record<string, unknown> => ({
  model: config.llm.model,
  messages: options.messages,
  temperature: options.temperature ?? config.llm.temperature,
  max_tokens: options.maxTokens ?? config.llm.maxTokens,
  stream: false,
  ...(options.json ? { response_format: { type: 'json_object' } } : {}),
  ...buildThinkingField(),
});

interface AttemptOutcome {
  ok: boolean;
  content: string;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
  /** 网络层错误（无 HTTP 状态码） */
  networkError: boolean;
  status: number | null;
  retryAfterMs: number | null;
  errorCode: ErrorCodeValueLocal;
  errorMessage: string | null;
}

type ErrorCodeValueLocal = (typeof ErrorCode)[keyof typeof ErrorCode];

/** 单次请求（含超时控制） */
const performAttempt = async (
  options: LlmCallOptions,
  attempt: number,
  doFetch: typeof fetch,
): Promise<AttemptOutcome> => {
  const timeoutMs = options.timeoutMs ?? config.llm.timeoutMs;
  const apiKey = options.apiKey ?? config.llm.apiKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await doFetch(`${config.llm.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(buildPayload(options)),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;
    const rawText = await response.text();

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      let message = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(rawText) as OpenAiChatResponse;
        if (parsed.error?.message) message = `${message}: ${parsed.error.message}`;
      } catch {
        if (rawText) message = `${message}: ${rawText.slice(0, 300)}`;
      }
      const isRateLimit = response.status === 429;
      return {
        ok: false,
        content: '',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: config.llm.model,
        latencyMs,
        networkError: false,
        status: response.status,
        retryAfterMs,
        errorCode: isRateLimit ? ErrorCode.LLM_RATE_LIMIT : ErrorCode.LLM_ERROR,
        errorMessage: message,
      };
    }

    let parsed: OpenAiChatResponse;
    try {
      parsed = JSON.parse(rawText) as OpenAiChatResponse;
    } catch (error) {
      return {
        ok: false,
        content: '',
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: config.llm.model,
        latencyMs,
        networkError: false,
        status: response.status,
        retryAfterMs: null,
        errorCode: ErrorCode.LLM_ERROR,
        errorMessage: `响应不是合法 JSON: ${(error as Error).message}`,
      };
    }

    const content = parsed.choices?.[0]?.message?.content ?? '';
    const promptTokens =
      parsed.usage?.prompt_tokens ??
      estimateTokensFromText(options.messages.map((m) => m.content).join('\n'));
    const completionTokens = parsed.usage?.completion_tokens ?? estimateTokensFromText(content);

    return {
      ok: true,
      content,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: parsed.usage?.total_tokens ?? promptTokens + completionTokens,
      },
      model: parsed.model ?? config.llm.model,
      latencyMs,
      networkError: false,
      status: response.status,
      retryAfterMs: null,
      errorCode: ErrorCode.LLM_ERROR,
      errorMessage: null,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const isAbort = (error as Error).name === 'AbortError' || controller.signal.aborted;
    return {
      ok: false,
      content: '',
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: config.llm.model,
      latencyMs,
      networkError: !isAbort,
      status: null,
      retryAfterMs: null,
      errorCode: isAbort ? ErrorCode.LLM_TIMEOUT : ErrorCode.LLM_ERROR,
      errorMessage: isAbort
        ? `LLM 请求超时（${timeoutMs}ms，第 ${attempt} 次尝试）`
        : `网络错误: ${(error as Error).message}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

export interface RawCallResult {
  content: string;
  usage: LlmUsage;
  costUsd: number;
  latencyMs: number;
  model: string;
  provider: string;
  mock: boolean;
  attempts: number;
  status: 'success' | 'error' | 'fallback';
  error: string | null;
  errorCode: ErrorCodeValueLocal | null;
}

/**
 * 统一入口：带重试、超时、限流与 llm_calls 落库的原始文本调用。
 * 失败时抛 AppError（LLM_TIMEOUT / LLM_RATE_LIMIT / LLM_ERROR）。
 */
export const callLlmRaw = async (options: LlmCallOptions): Promise<RawCallResult> => {
  const maxRetries = options.maxRetries ?? config.llm.maxRetries;
  const doFetch = options.fetchImpl ?? fetch;
  const runId = options.runId ?? null;
  const useMock = options.mock ?? config.llm.mock;

  const logAttempt = (
    outcome: AttemptOutcome | null,
    attempt: number,
    status: 'success' | 'error' | 'fallback',
    costUsd: number,
    error: string | null,
  ): void => {
    const usage = outcome?.usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    // 注意：字段名必须与 LlmCallLogInput（camelCase）一致，否则 run_id 会被写成 null
    const payload: LlmCallLogInput = {
      runId,
      provider: config.llm.provider,
      model: outcome?.model ?? config.llm.model,
      operation: options.operation,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      latencyMs: outcome?.latencyMs ?? 0,
      costUsd,
      status,
      attempt,
      mock: useMock,
      error,
    };
    if (options.db) {
      logLlmCall(options.db, payload);
    }
    logger.info(
      {
        run_id: runId,
        provider: payload.provider,
        model: payload.model,
        operation: options.operation,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        latency_ms: payload.latencyMs,
        cost_usd: costUsd,
        status,
        attempt,
        mock: config.llm.mock,
        error,
      },
      'llm_call',
    );
  };

  /* ---------------- Mock 模式 ---------------- */
  if (useMock) {
    const startedAt = Date.now();
    const mockResult = mockLlm(options.operation, options.messages);
    const latencyMs = Math.max(1, Date.now() - startedAt);
    const promptTokens =
      mockResult.usage.prompt_tokens ||
      estimateTokensFromText(options.messages.map((m) => m.content).join('\n'));
    const completionTokens =
      mockResult.usage.completion_tokens || estimateTokensFromText(mockResult.content);
    const usage: LlmUsage = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    };
    const outcome: AttemptOutcome = {
      ok: true,
      content: mockResult.content,
      usage,
      model: 'mock',
      latencyMs,
      networkError: false,
      status: 200,
      retryAfterMs: null,
      errorCode: ErrorCode.LLM_ERROR,
      errorMessage: null,
    };
    logAttempt(outcome, 1, 'success', 0, null);
    return {
      content: mockResult.content,
      usage,
      costUsd: 0,
      latencyMs,
      model: 'mock',
      provider: 'mock',
      mock: true,
      attempts: 1,
      status: 'success',
      error: null,
      errorCode: null,
    };
  }

  /* ---------------- 真实调用：重试 + 退避 ---------------- */
  let lastOutcome: AttemptOutcome | null = null;
  const totalAttempts = maxRetries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const outcome = await performAttempt(options, attempt, doFetch);
    lastOutcome = outcome;

    if (outcome.ok) {
      const costUsd = estimateCostUsd(
        outcome.model,
        outcome.usage.prompt_tokens,
        outcome.usage.completion_tokens,
      );
      logAttempt(outcome, attempt, 'success', costUsd, null);
      return {
        content: outcome.content,
        usage: outcome.usage,
        costUsd,
        latencyMs: outcome.latencyMs,
        model: outcome.model,
        provider: config.llm.provider,
        mock: false,
        attempts: attempt,
        status: 'success',
        error: null,
        errorCode: null,
      };
    }

    const retryable =
      outcome.networkError || (outcome.status !== null && isRetryableStatus(outcome.status));
    const attemptsLeft = totalAttempts - attempt;

    if (!retryable || attemptsLeft <= 0) {
      logAttempt(outcome, attempt, 'error', 0, outcome.errorMessage);
      throw new AppError(outcome.errorCode, outcome.errorMessage ?? 'LLM 调用失败', {
        details: {
          operation: options.operation,
          status: outcome.status,
          attempt,
          total_attempts: totalAttempts,
          retry_after_ms: outcome.retryAfterMs,
        },
        cause: outcome.errorMessage,
      });
    }

    // 429 优先使用服务端 Retry-After，其次是截断的指数退避
    const delay =
      outcome.errorCode === ErrorCode.LLM_RATE_LIMIT && outcome.retryAfterMs !== null
        ? Math.min(Math.max(outcome.retryAfterMs, backoffDelayMs(attempt)), 60000)
        : backoffDelayMs(attempt);

    logger.warn(
      {
        run_id: runId,
        operation: options.operation,
        attempt,
        total_attempts: totalAttempts,
        status: outcome.status,
        retry_after_ms: outcome.retryAfterMs,
        delay_ms: delay,
        error: outcome.errorMessage,
      },
      'llm_call_retry',
    );

    // 重试等待期间不写 llm_calls，最终结果统一记录（避免噪声）
    await sleep(delay);
  }

  const fallbackError = lastOutcome?.errorMessage ?? 'LLM 调用失败';
  logAttempt(lastOutcome, totalAttempts, 'error', 0, fallbackError);
  throw new AppError(lastOutcome?.errorCode ?? ErrorCode.LLM_ERROR, fallbackError, {
    details: { operation: options.operation, attempt: totalAttempts },
  });
};

/**
 * 保证开启 response_format=json_object 时 prompt 里含 "json" 字样。
 *
 * 原因：DeepSeek / OpenAI 在 `response_format: { type: 'json_object' }` 下，
 * 要求 messages 中必须出现 "json"（大小写不敏感），否则直接返回
 * 400 "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'"。
 * 调用方很容易漏写，因此这里统一补一句 system 指令兜底。
 */
export const ensureJsonInstruction = (messages: LlmMessage[]): LlmMessage[] => {
  const hasJson = messages.some((message) => /json/i.test(message.content));
  if (hasJson) return messages;
  return [
    {
      role: 'system',
      content: 'You must respond with a single valid JSON object only, no prose and no markdown fences.',
    },
    ...messages,
  ];
};

/**
 * 结构化调用：要求 JSON 输出并用 Zod 校验。
 * 校验失败 → AppError(LLM_INVALID_OUTPUT, 502)
 */
export const callLlmJson = async <T>(
  options: LlmCallOptions,
  schema: z.ZodType<T>,
): Promise<LlmCallResult<T>> => {
  const raw = await callLlmRaw({
    ...options,
    json: true,
    messages: ensureJsonInstruction(options.messages),
  });
  const parsed = extractJsonObject(raw.content);
  const result = schema.safeParse(parsed);

  if (!result.success) {
    const error = new AppError(
      ErrorCode.LLM_INVALID_OUTPUT,
      `LLM 输出未通过 Zod 校验: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      {
        details: { operation: options.operation, raw_content: raw.content.slice(0, 500) },
      },
    );
    if (options.db) {
      logLlmCall(options.db, {
        runId: options.runId ?? null,
        provider: raw.provider,
        model: raw.model,
        operation: options.operation,
        promptTokens: raw.usage.prompt_tokens,
        completionTokens: raw.usage.completion_tokens,
        latencyMs: raw.latencyMs,
        costUsd: raw.costUsd,
        status: 'error',
        attempt: raw.attempts,
        mock: raw.mock,
        error: error.message,
      });
    }
    throw error;
  }

  return {
    content: raw.content,
    data: result.data,
    usage: raw.usage,
    cost_usd: raw.costUsd,
    latency_ms: raw.latencyMs,
    model: raw.model,
    provider: raw.provider,
    mock: raw.mock,
    attempts: raw.attempts,
    fallback: false,
    error: null,
  };
};

export const llmService = {
  callLlmRaw,
  callLlmJson,
  isMockMode: (): boolean => config.llm.mock,
  provider: () => config.llm.provider,
  model: () => config.llm.model,
};

export default llmService;
