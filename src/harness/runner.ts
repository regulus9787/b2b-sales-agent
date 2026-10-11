/**
 * Agent Runner（AGENTS.md 第 8 节）
 *  - 从 tools.ts 装载工具注册表
 *  - 每次执行写 agent_runs 与 agent_run_steps
 *  - 汇总该次执行的 llm_calls 数量、token 与成本
 */
import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { AppError, ErrorCode } from '../core/errors';
import { recordEvent } from '../core/events';
import { nowIso } from '../db/db';
import type { AgentRunRow, AgentRunStepRow } from '../core/models';
import { logger } from '../middleware/logger';
import { ALL_TOOLS, TOOL_CATALOG, type ToolContext, type ToolDefinition } from './tools';

export type { ToolContext, ToolDefinition };
export { TOOL_CATALOG };

export interface ToolStepRecord {
  step_index: number;
  tool: string;
  status: 'succeeded' | 'failed';
  input: unknown;
  output: unknown;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export interface AgentRunResult<TOut = unknown> {
  run_id: string;
  workflow: string;
  status: 'succeeded' | 'failed';
  customer_id: number | null;
  output: TOut | null;
  error: string | null;
  steps: ToolStepRecord[];
  duration_ms: number;
  started_at: string;
  finished_at: string;
  llm_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
}

/** 创建工具注册表（name → tool） */
export const createToolRegistry = (): Map<string, ToolDefinition> => {
  const registry = new Map<string, ToolDefinition>();
  for (const tool of ALL_TOOLS) {
    registry.set(tool.name, tool);
  }
  return registry;
};

export const listToolNames = (): string[] => [...createToolRegistry().keys()];

/** 工作流执行器可以调用的工具集 */
export interface ToolCaller {
  call<TIn, TOut>(name: string, input: TIn): Promise<TOut>;
}

export interface StartRunInput {
  workflow: string;
  customerId?: number | null;
  input?: unknown;
  trigger?: string;
  requestId?: string | null;
}

export type WorkflowExecutor<TOut> = (context: ToolContext, tools: ToolCaller) => Promise<TOut>;

/**
 * 执行工作流：
 *  1. 创建 agent_runs（status=running）
 *  2. 逐步调用工具，每步写入 agent_run_steps（含输入/输出/耗时/错误）
 *  3. 汇总 llm_calls 的调用次数、token、成本
 *  4. 更新 agent_runs（succeeded / failed）
 */
export const executeWorkflow = async <TOut>(
  db: Database,
  start: StartRunInput,
  executor: WorkflowExecutor<TOut>,
): Promise<AgentRunResult<TOut>> => {
  const runId = randomUUID();
  const startedAt = nowIso();
  const startedMs = Date.now();
  const steps: ToolStepRecord[] = [];

  db.prepare(
    `INSERT INTO agent_runs (run_id, workflow, status, trigger, customer_id, input, request_id, started_at, created_at)
     VALUES (@run_id, @workflow, 'running', @trigger, @customer_id, @input, @request_id, @started_at, @started_at)`,
  ).run({
    run_id: runId,
    workflow: start.workflow,
    trigger: start.trigger ?? 'api',
    customer_id: start.customerId ?? null,
    input: start.input === undefined ? null : JSON.stringify(start.input),
    request_id: start.requestId ?? null,
    started_at: startedAt,
  });

  if (start.customerId) {
    recordEvent(db, {
      customerId: start.customerId,
      eventType: 'agent_run_started',
      trigger: start.trigger ?? 'api',
      runId,
      actor: 'agent',
      payload: { workflow: start.workflow },
      requestId: start.requestId ?? null,
    });
  }

  const registry = createToolRegistry();
  const context: ToolContext = {
    db,
    runId,
    requestId: start.requestId ?? null,
    customerId: start.customerId ?? null,
  };

  const insertStep = db.prepare(
    `INSERT INTO agent_run_steps (run_id, step_index, tool, status, input, output, error, duration_ms, created_at)
     VALUES (@run_id, @step_index, @tool, @status, @input, @output, @error, @duration_ms, @created_at)`,
  );

  const recordStep = (step: ToolStepRecord): void => {
    steps.push(step);
    insertStep.run({
      run_id: runId,
      step_index: step.step_index,
      tool: step.tool,
      status: step.status,
      input: step.input === undefined ? null : JSON.stringify(step.input),
      output: step.output === undefined ? null : JSON.stringify(step.output),
      error: step.error,
      duration_ms: step.duration_ms,
      created_at: step.created_at,
    });
  };

  const call = async <TIn, TOut>(name: string, rawInput: TIn): Promise<TOut> => {
    const tool = registry.get(name);
    if (!tool) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, `未注册的工具: ${name}`);
    }

    const stepIndex = steps.length + 1;
    const stepStarted = Date.now();

    const parsedInput = tool.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      const errorMessage = `工具 ${name} 输入校验失败: ${parsedInput.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`;
      recordStep({
        step_index: stepIndex,
        tool: name,
        status: 'failed',
        input: rawInput,
        output: null,
        error: errorMessage,
        duration_ms: Date.now() - stepStarted,
        created_at: nowIso(),
      });
      throw new AppError(ErrorCode.VALIDATION_ERROR, errorMessage);
    }

    try {
      const output = await tool.handler(parsedInput.data, context);
      const parsedOutput = tool.outputSchema.safeParse(output);
      if (!parsedOutput.success) {
        const errorMessage = `工具 ${name} 输出校验失败: ${parsedOutput.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`;
        recordStep({
          step_index: stepIndex,
          tool: name,
          status: 'failed',
          input: parsedInput.data,
          output,
          error: errorMessage,
          duration_ms: Date.now() - stepStarted,
          created_at: nowIso(),
        });
        throw new AppError(ErrorCode.INTERNAL_ERROR, errorMessage);
      }

      recordStep({
        step_index: stepIndex,
        tool: name,
        status: 'succeeded',
        input: parsedInput.data,
        output: parsedOutput.data,
        error: null,
        duration_ms: Date.now() - stepStarted,
        created_at: nowIso(),
      });
      return parsedOutput.data as TOut;
    } catch (error) {
      const appError =
        error instanceof AppError
          ? error
          : new AppError(
              ErrorCode.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            );
      const alreadyRecorded = steps.some(
        (step) => step.step_index === stepIndex && step.tool === name,
      );
      if (!alreadyRecorded) {
        recordStep({
          step_index: stepIndex,
          tool: name,
          status: 'failed',
          input: parsedInput.data,
          output: null,
          error: `${appError.code}: ${appError.message}`,
          duration_ms: Date.now() - stepStarted,
          created_at: nowIso(),
        });
      }
      throw appError;
    }
  };

  const finalize = (
    status: 'succeeded' | 'failed',
    output: TOut | null,
    error: string | null,
  ): AgentRunResult<TOut> => {
    const finishedAt = nowIso();
    const durationMs = Date.now() - startedMs;

    const llmStats = db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(total_tokens),0) AS tokens, COALESCE(SUM(cost_usd),0) AS cost
         FROM llm_calls WHERE run_id = ?`,
      )
      .get(runId) as { calls: number; tokens: number; cost: number };

    db.prepare(
      `UPDATE agent_runs SET status = @status, output = @output, error = @error, steps_count = @steps_count,
         llm_calls_count = @llm_calls_count, total_tokens = @total_tokens, total_cost_usd = @total_cost_usd,
         duration_ms = @duration_ms, finished_at = @finished_at
       WHERE run_id = @run_id`,
    ).run({
      status,
      output: output === null ? null : JSON.stringify(output),
      error,
      steps_count: steps.length,
      llm_calls_count: llmStats.calls,
      total_tokens: llmStats.tokens,
      total_cost_usd: Number(llmStats.cost.toFixed(8)),
      duration_ms: durationMs,
      finished_at: finishedAt,
      run_id: runId,
    });

    if (start.customerId) {
      recordEvent(db, {
        customerId: start.customerId,
        eventType: 'agent_run_finished',
        trigger: start.trigger ?? 'api',
        runId,
        actor: 'agent',
        payload: {
          workflow: start.workflow,
          status,
          steps: steps.length,
          llm_calls: llmStats.calls,
          total_tokens: llmStats.tokens,
          cost_usd: llmStats.cost,
          duration_ms: durationMs,
          error,
        },
        requestId: start.requestId ?? null,
      });
    }

    logger.info(
      {
        run_id: runId,
        workflow: start.workflow,
        status,
        steps: steps.length,
        llm_calls: llmStats.calls,
        total_tokens: llmStats.tokens,
        cost_usd: llmStats.cost,
        duration_ms: durationMs,
        error,
      },
      'agent_run_finished',
    );

    return {
      run_id: runId,
      workflow: start.workflow,
      status,
      customer_id: start.customerId ?? null,
      output,
      error,
      steps,
      duration_ms: durationMs,
      started_at: startedAt,
      finished_at: finishedAt,
      llm_calls_count: llmStats.calls,
      total_tokens: llmStats.tokens,
      total_cost_usd: Number(llmStats.cost.toFixed(8)),
    };
  };

  try {
    const output = await executor(context, { call });
    return finalize('succeeded', output, null);
  } catch (error) {
    const message =
      error instanceof AppError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return finalize('failed', null, message);
  }
};

/* ------------------------------------------------------------------ */
/* 查询 agent_runs / agent_run_steps                                   */
/* ------------------------------------------------------------------ */

export interface AgentRunStepDto {
  step_index: number;
  tool: string;
  status: 'succeeded' | 'failed';
  input: unknown;
  output: unknown;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export interface AgentRunLlmCallDto {
  id: number;
  operation: string;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  cost_usd: number;
  status: string;
  attempt: number;
  mock: boolean;
  error: string | null;
  created_at: string;
}

export interface AgentRunEventDto {
  id: number;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  trigger: string;
  created_at: string;
}

export interface AgentRunDetailDto {
  run_id: string;
  workflow: string;
  status: 'running' | 'succeeded' | 'failed';
  trigger: string;
  customer_id: number | null;
  input: unknown;
  output: unknown;
  error: string | null;
  steps_count: number;
  llm_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  request_id: string | null;
  started_at: string;
  finished_at: string | null;
  steps: AgentRunStepDto[];
  llm_calls: AgentRunLlmCallDto[];
  events: AgentRunEventDto[];
}

const safeParseJson = (value: string | null): unknown => {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const getAgentRunDetail = (db: Database, runId: string): AgentRunDetailDto | null => {
  const run = db.prepare('SELECT * FROM agent_runs WHERE run_id = ?').get(runId) as
    AgentRunRow | undefined;
  if (!run) return null;

  const steps = db
    .prepare('SELECT * FROM agent_run_steps WHERE run_id = ? ORDER BY step_index ASC')
    .all(runId) as AgentRunStepRow[];

  const llmCalls = db
    .prepare(
      `SELECT id, operation, provider, model, prompt_tokens, completion_tokens, total_tokens,
              latency_ms, cost_usd, status, attempt, mock, error, created_at
       FROM llm_calls WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(runId) as (Omit<AgentRunLlmCallDto, 'mock'> & { mock: number })[];

  const events = db
    .prepare(
      `SELECT id, event_type, from_status, to_status, trigger, created_at
       FROM events WHERE run_id = ? ORDER BY id ASC`,
    )
    .all(runId) as AgentRunEventDto[];

  return {
    run_id: run.run_id,
    workflow: run.workflow,
    status: run.status,
    trigger: run.trigger,
    customer_id: run.customer_id,
    input: safeParseJson(run.input),
    output: safeParseJson(run.output),
    error: run.error,
    steps_count: run.steps_count,
    llm_calls_count: run.llm_calls_count,
    total_tokens: run.total_tokens,
    total_cost_usd: run.total_cost_usd,
    duration_ms: run.duration_ms,
    request_id: run.request_id,
    started_at: run.started_at,
    finished_at: run.finished_at,
    steps: steps.map((step) => ({
      step_index: step.step_index,
      tool: step.tool,
      status: step.status,
      input: safeParseJson(step.input),
      output: safeParseJson(step.output),
      error: step.error,
      duration_ms: step.duration_ms,
      created_at: step.created_at,
    })),
    llm_calls: llmCalls.map((call) => ({ ...call, mock: call.mock === 1 })),
    events,
  };
};

export const listAgentRuns = (
  db: Database,
  options: { page?: number; pageSize?: number; customerId?: number; status?: string } = {},
): { items: AgentRunRow[]; total: number; page: number; pageSize: number } => {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: unknown[] = [];
  if (options.customerId !== undefined) {
    where.push('customer_id = ?');
    params.push(options.customerId);
  }
  if (options.status !== undefined) {
    where.push('status = ?');
    params.push(options.status);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM agent_runs ${whereSql}`).get(...params) as { c: number }
  ).c;
  const items = db
    .prepare(`SELECT * FROM agent_runs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as AgentRunRow[];

  return { items, total, page, pageSize };
};

export const agentRunner = {
  executeWorkflow,
  createToolRegistry,
  listToolNames,
  getAgentRunDetail,
  listAgentRuns,
};

export default agentRunner;
