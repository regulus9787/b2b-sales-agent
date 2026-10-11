/**
 * LLM 调用记录（AGENTS.md 第 5 / 7 节）
 * llm_calls 表字段：run_id、model、prompt_tokens、completion_tokens、latency_ms、cost、status、error
 */
import type { Database } from 'better-sqlite3';
import type { LlmCallDto } from '../core/models';
import { toLlmCallDto } from '../core/models';
import { nowIso } from '../db/db';

export interface LlmCallLogInput {
  runId?: string | null;
  provider: string;
  model: string;
  /** 逻辑操作名：generate_email / classify_intent / suggest_next_action */
  operation: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  costUsd: number;
  status: 'success' | 'error' | 'fallback';
  attempt: number;
  mock: boolean;
  error?: string | null;
}

interface LlmCallRow {
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
  status: string;
  attempt: number;
  mock: number;
  error: string | null;
  created_at: string;
}

export const logLlmCall = (db: Database, input: LlmCallLogInput): LlmCallDto => {
  const info = db
    .prepare(
      `INSERT INTO llm_calls (run_id, provider, model, operation, prompt_tokens, completion_tokens,
                              total_tokens, latency_ms, cost_usd, status, attempt, mock, error, created_at)
       VALUES (@run_id, @provider, @model, @operation, @prompt_tokens, @completion_tokens,
               @total_tokens, @latency_ms, @cost_usd, @status, @attempt, @mock, @error, @created_at)`,
    )
    .run({
      run_id: input.runId ?? null,
      provider: input.provider,
      model: input.model,
      operation: input.operation,
      prompt_tokens: input.promptTokens,
      completion_tokens: input.completionTokens,
      total_tokens: input.promptTokens + input.completionTokens,
      latency_ms: Math.round(input.latencyMs),
      cost_usd: Number(input.costUsd.toFixed(8)),
      status: input.status,
      attempt: input.attempt,
      mock: input.mock ? 1 : 0,
      error: input.error ?? null,
      created_at: nowIso(),
    });

  const row = db
    .prepare('SELECT * FROM llm_calls WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as LlmCallRow;
  return toLlmCallDto(row);
};

export interface LlmCallStats {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: number;
  avg_latency_ms: number;
  errors: number;
  fallbacks: number;
  mock_calls: number;
}

export const getLlmCallStats = (db: Database, runId?: string): LlmCallStats => {
  const where = runId ? 'WHERE run_id = ?' : '';
  const row = db
    .prepare(
      `SELECT COUNT(*) AS calls,
              COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens),0) AS completion_tokens,
              COALESCE(SUM(total_tokens),0) AS total_tokens,
              COALESCE(SUM(cost_usd),0) AS cost_usd,
              COALESCE(AVG(latency_ms),0) AS avg_latency_ms,
              COALESCE(SUM(CASE WHEN status='error' THEN 1 ELSE 0 END),0) AS errors,
              COALESCE(SUM(CASE WHEN status='fallback' THEN 1 ELSE 0 END),0) AS fallbacks,
              COALESCE(SUM(CASE WHEN mock=1 THEN 1 ELSE 0 END),0) AS mock_calls
       FROM llm_calls ${where}`,
    )
    .get(...(runId ? [runId] : [])) as Omit<LlmCallStats, 'avg_latency_ms'> & {
    avg_latency_ms: number;
  };

  return { ...row, avg_latency_ms: Math.round(row.avg_latency_ms) };
};

export const listLlmCallsByRun = (db: Database, runId: string): LlmCallDto[] => {
  const rows = db
    .prepare('SELECT * FROM llm_calls WHERE run_id = ? ORDER BY id ASC')
    .all(runId) as LlmCallRow[];
  return rows.map(toLlmCallDto);
};

export default logLlmCall;
