/**
 * 单元测试：LLM 网关（src/services/llm.ts）
 *  - 纯函数：Retry-After 解析、指数退避、JSON 抽取
 *  - 重试/超时/限流：注入 fetchImpl（不依赖真实网络）
 *  - Mock 模式：零密钥可跑的确定性行为
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import {
  backoffDelayMs,
  callLlmJson,
  callLlmRaw,
  ensureJsonInstruction,
  extractJsonObject,
  isRetryableStatus,
  parseRetryAfter,
} from '../../src/services/llm';
import { openDatabase } from '../../src/db/db';
import { AppError, ErrorCode } from '../../src/core/errors';
import { estimateCostUsd, resolvePricing } from '../../src/services/pricing';
import { mockCustomerReply, ruleBasedIntent } from '../../src/services/llm-mock';

let db: Database;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
});

afterEach(() => {
  db.close();
});

/** 走真实调用分支的公共参数（mock:false 覆盖全局 Mock 模式） */
const liveOptions = { mock: false, apiKey: 'test-key' } as const;

describe('llm 网关 · 纯函数', () => {
  it('isRetryableStatus 只对 429 / 5xx 返回 true', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });

  it('parseRetryAfter 支持秒数与 HTTP 日期', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0.5')).toBe(500);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not-a-number')).toBeNull();

    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:03 GMT', now)).toBe(3000);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('backoffDelayMs 指数增长且有上限', () => {
    expect(backoffDelayMs(1, 100, 0)).toBe(100);
    expect(backoffDelayMs(2, 100, 0)).toBe(200);
    expect(backoffDelayMs(3, 100, 0)).toBe(400);
    expect(backoffDelayMs(20, 500, 0)).toBeLessThanOrEqual(30000);
  });

  it('extractJsonObject 兼容代码块与前后解释文字', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(extractJsonObject('```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJsonObject('好的，结果如下：{"a":3} 以上。')).toEqual({ a: 3 });
    expect(extractJsonObject('not json')).toBeNull();
  });

  it('定价表可解析并按 token 计算成本', () => {
    const pricing = resolvePricing('deepseek-chat');
    expect(pricing.inputPer1k).toBeGreaterThan(0);
    expect(estimateCostUsd('deepseek-chat', 1000, 500)).toBeCloseTo(0.00082, 8);
    expect(estimateCostUsd('totally-unknown-model', 1000, 1000)).toBe(0);
  });
});

describe('llm 网关 · Mock 模式', () => {
  it('Mock 模式返回模型名 mock 且成本为 0', async () => {
    const result = await callLlmRaw({
      operation: 'generate_email',
      db,
      messages: [{ role: 'user', content: 'COMPANY: Mock Co\nCONTACT: Ada\nINDUSTRY: SaaS 软件' }],
    });
    expect(result.mock).toBe(true);
    expect(result.model).toBe('mock');
    expect(result.costUsd).toBe(0);
    expect(result.content).toContain('SUBJECT:');
    expect(result.usage.prompt_tokens).toBeGreaterThan(0);
  });

  it('Mock 模式写入 llm_calls（run_id/tokens/status）', async () => {
    const runId = 'run-mock-1';
    await callLlmRaw({
      operation: 'classify_intent',
      db,
      runId,
      messages: [{ role: 'user', content: 'REPLY_TEXT: 我们对这个方案很感兴趣，能否安排演示？' }],
    });
    const row = db
      .prepare('SELECT run_id, operation, status, mock, prompt_tokens FROM llm_calls')
      .get() as {
      run_id: string;
      operation: string;
      status: string;
      mock: number;
      prompt_tokens: number;
    };
    expect(row.run_id).toBe(runId);
    expect(row.operation).toBe('classify_intent');
    expect(row.status).toBe('success');
    expect(row.mock).toBe(1);
    expect(row.prompt_tokens).toBeGreaterThan(0);
  });

  it('callLlmJson 校验通过时返回解析后的数据', async () => {
    const schema = z.object({
      intent: z.enum(['interested', 'needs_info', 'rejected', 'neutral']),
    });
    const result = await callLlmJson(
      {
        operation: 'classify_intent',
        db,
        messages: [{ role: 'user', content: 'REPLY_TEXT: 需要更多资料，价格怎么算？' }],
      },
      schema,
    );
    expect(result.data.intent).toBe('needs_info');
    expect(result.fallback).toBe(false);
  });

  it('callLlmJson 会自动补上 json 指令（否则真实 API 返回 400）', () => {
    // 回归：DeepSeek/OpenAI 在 response_format=json_object 下要求 prompt 含 "json"
    const withoutJson = ensureJsonInstruction([
      { role: 'user', content: '请分类这段客户回复：我们对方案很感兴趣' },
    ]);
    expect(withoutJson).toHaveLength(2);
    expect(withoutJson[0]?.role).toBe('system');
    expect(withoutJson[0]?.content).toMatch(/json/i);

    // 已经含 json 时不重复注入
    const withJson = ensureJsonInstruction([
      { role: 'system', content: '你只输出一个 JSON 对象' },
      { role: 'user', content: '分类这段回复' },
    ]);
    expect(withJson).toHaveLength(2);
  });

  it('callLlmJson 实际发送的请求体带 response_format 且 prompt 含 json', async () => {
    let captured: Record<string, unknown> | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      // 模拟真实 API 的校验：prompt 不含 json 就返回 400
      const messages = (captured.messages ?? []) as { content: string }[];
      const hasJson = messages.some((message) => /json/i.test(message.content));
      if (!hasJson) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                "Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'.",
            },
          }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify({
          model: 'deepseek-flash',
          choices: [{ message: { content: '{"intent":"interested"}' } }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const schema = z.object({ intent: z.literal('interested') });
    const result = await callLlmJson(
      {
        operation: 'classify_intent',
        messages: [{ role: 'user', content: '分类：我们对方案很感兴趣' }],
        fetchImpl,
        maxRetries: 0,
        ...liveOptions,
      },
      schema,
    );

    expect(result.data.intent).toBe('interested');
    expect(captured).not.toBeNull();
    expect((captured as unknown as { response_format: unknown }).response_format).toEqual({
      type: 'json_object',
    });
    expect(result.mock).toBe(false);
  });

  it('callLlmJson 校验失败抛 LLM_INVALID_OUTPUT 并记录 error 状态', async () => {
    const strictSchema = z.object({ intent: z.literal('totally_different') });
    await expect(
      callLlmJson(
        {
          operation: 'classify_intent',
          db,
          messages: [{ role: 'user', content: 'REPLY_TEXT: 你好' }],
        },
        strictSchema,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.LLM_INVALID_OUTPUT });

    const row = db.prepare("SELECT COUNT(*) AS c FROM llm_calls WHERE status = 'error'").get() as {
      c: number;
    };
    expect(row.c).toBeGreaterThan(0);
  });

  it('未注册 operation 的 Mock 返回占位内容而不抛错', async () => {
    const result = await callLlmRaw({
      operation: 'unknown_operation',
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(result.content).toContain('mock-llm');
  });
});

describe('llm 网关 · 重试 / 超时 / 限流（注入 fetch）', () => {
  it('5xx 后重试成功：记录两次尝试、成本与 token', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: 'server error' } }), {
          status: 500,
        });
      }
      return new Response(
        JSON.stringify({
          model: 'deepseek-chat',
          choices: [{ message: { content: '{"intent":"interested"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await callLlmRaw({
      operation: 'classify_intent',
      db,
      messages: [{ role: 'user', content: 'hi' }],
      fetchImpl,
      maxRetries: 2,
      ...liveOptions,
    });

    expect(calls).toBe(2);
    expect(result.mock).toBe(false);
    expect(result.content).toContain('interested');
    expect(result.usage.total_tokens).toBe(15);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(result.attempts).toBe(2);

    const row = db
      .prepare('SELECT run_id IS NULL AS no_run, status, prompt_tokens FROM llm_calls')
      .get() as { no_run: number; status: string; prompt_tokens: number };
    expect(row.status).toBe('success');
    expect(row.prompt_tokens).toBe(10);
  });

  it('400 不重试：仅请求一次并抛 LLM_ERROR', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'bad request' } }), { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      callLlmRaw({
        operation: 'classify_intent',
        db,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
        maxRetries: 3,
        ...liveOptions,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LLM_ERROR });
    expect(calls).toBe(1);
  });

  it('超时抛 LLM_TIMEOUT（AbortController 生效）', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      })) as unknown as typeof fetch;

    await expect(
      callLlmRaw({
        operation: 'classify_intent',
        messages: [{ role: 'user', content: 'slow' }],
        fetchImpl,
        timeoutMs: 30,
        maxRetries: 0,
        ...liveOptions,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LLM_TIMEOUT });
  });

  it('持续 429 抛 LLM_RATE_LIMIT（读取 Retry-After）', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: 'slow down' } }), {
        status: 429,
        headers: { 'retry-after': '0' },
      });
    }) as unknown as typeof fetch;

    await expect(
      callLlmRaw({
        operation: 'classify_intent',
        db,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
        maxRetries: 1,
        ...liveOptions,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LLM_RATE_LIMIT });
    expect(calls).toBe(2); // 1 次初始 + 1 次重试
  });

  it('网络错误被识别为可重试错误（最终抛 LLM_ERROR）', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    await expect(
      callLlmRaw({
        operation: 'classify_intent',
        db,
        messages: [{ role: 'user', content: 'hi' }],
        fetchImpl,
        maxRetries: 1,
        ...liveOptions,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LLM_ERROR });
    expect(calls).toBe(2);
  });
});

describe('llm-mock 规则分类器', () => {
  it('四类意图关键词均可识别', () => {
    expect(ruleBasedIntent('我们对方案很感兴趣，能否安排一次演示？').intent).toBe('interested');
    expect(ruleBasedIntent('请发一份详细报价和技术规格文档').intent).toBe('needs_info');
    expect(ruleBasedIntent('我们没有预算，已经在用其他供应商，请不要再联系').intent).toBe(
      'rejected',
    );
    expect(ruleBasedIntent('收到，谢谢，我转给相关同事了').intent).toBe('neutral');
  });

  it('空文本 → neutral，且 hits 为 0', () => {
    expect(ruleBasedIntent('')).toEqual({ intent: 'neutral', hits: 0 });
  });

  it('mockCustomerReply 四类意图内容可被自身规则识别（自洽性）', () => {
    for (const intent of ['interested', 'needs_info', 'rejected', 'neutral'] as const) {
      const body = mockCustomerReply(intent, {
        contactName: 'A',
        companyName: 'B',
        senderName: 'C',
      });
      expect(body.length).toBeGreaterThan(20);
      expect(ruleBasedIntent(body).intent).toBe(intent);
    }
  });

  it('AppError 携带 details 与 httpStatus', () => {
    const error = new AppError(ErrorCode.LLM_TIMEOUT, 'timeout', { details: { attempt: 3 } });
    expect(error.httpStatus).toBe(504);
    expect(error.details).toEqual({ attempt: 3 });
    expect(error.name).toBe('AppError');
  });
});
