/**
 * Agent 工作流编排（AGENTS.md 第 8 节）
 *
 * 完整工作流：import_leads → score_lead → generate_email → send → receive_reply
 *             → classify_reply → update_status
 * 每个工作流都通过 Runner 执行，工具调用与输入输出自动写入 agent_run_steps。
 */
import type { Database } from 'better-sqlite3';
import { AppError, ErrorCode, customerNotFound } from '../core/errors';
import type { ReplyIntent } from '../core/status';
import { executeWorkflow, type AgentRunResult } from './runner';
import type { importLeadsInputSchema, importLeadsOutputSchema } from './tools';
import type { z } from 'zod';

export const WORKFLOWS = ['full_cycle', 'import_and_draft', 'classify_only'] as const;
export type WorkflowName = (typeof WORKFLOWS)[number];

export const WORKFLOW_DESCRIPTIONS: Record<WorkflowName, string> = {
  full_cycle: '完整链路：评分 → 生成开发信 → 模拟发送 → 模拟客户回复 → 意图分类 → 自动更新状态',
  import_and_draft: '导入线索 → 评分 → 为前 N 个客户生成开发信（不模拟回复）',
  classify_only: '只跑回复分类链路：模拟客户回复 → 意图分类 → 自动更新状态',
};

export interface WorkflowInput {
  workflow: WorkflowName;
  customerId?: number;
  leads?: z.infer<typeof importLeadsInputSchema>['leads'];
  simulateIntent?: ReplyIntent;
  sendEmail?: boolean;
  limit?: number;
  trigger?: string;
}

export interface WorkflowStepSummary {
  step_index: number;
  tool: string;
  status: 'succeeded' | 'failed';
  duration_ms: number;
  error: string | null;
  /** 该步的简要结论，便于前端直接展示 */
  summary: string;
}

export interface WorkflowOutput {
  workflow: WorkflowName;
  customers: FullCycleCustomerResult[];
  steps: WorkflowStepSummary[];
  final_status: string | null;
  totals: {
    customers: number;
    emails: number;
    replies: number;
    intent_changes: number;
    tokens: number;
    cost_usd: number;
  };
}

export interface FullCycleCustomerResult {
  customer_id: number;
  company_name: string;
  score: number;
  email_id: number | null;
  email_subject: string | null;
  reply_id: number | null;
  reply_body: string | null;
  intent: string | null;
  confidence: number | null;
  needs_human: boolean | null;
  suggested_action: string | null;
  from_status: string;
  to_status: string;
  status_changed: boolean;
  next_action: string | null;
  llm: {
    model: string | null;
    provider: string | null;
    prompt_tokens: number;
    completion_tokens: number;
    latency_ms: number;
    cost_usd: number;
    mock: boolean;
    fallback: boolean;
  };
}

/* ------------------------------------------------------------------ */
/* 工具输出的类型引用（避免 any）                                       */
/* ------------------------------------------------------------------ */

type ImportLeadsOutput = z.infer<typeof importLeadsOutputSchema>;
type ScoreLeadOutput = {
  customer_id: number;
  company_name: string;
  score: number;
  reason: string;
  signals: string[];
  status: string;
};
type GenerateEmailOutput = {
  customer_id: number;
  email_id: number;
  subject: string;
  body: string;
  status: 'draft' | 'sent';
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
  mock: boolean;
  prompt_version: string;
  from_status: string;
  to_status: string;
};
type ClassifyReplyOutput = {
  customer_id: number;
  reply_id: number;
  reply_body: string;
  simulated: boolean;
  intent: string;
  confidence: number;
  sentiment: string;
  summary: string;
  suggested_action: string;
  needs_human: boolean;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
  mock: boolean;
  prompt_version: string;
  fallback: boolean;
  from_status: string;
  to_status: string;
  status_changed: boolean;
  status_change_error: string | null;
};
type SuggestNextActionOutput = {
  customer_id: number;
  action: string;
  priority: 'high' | 'medium' | 'low';
  due_in_days: number;
  reason: string;
  playbook: string[];
  fallback: boolean;
};

/* ------------------------------------------------------------------ */
/* 单客户完整链路                                                      */
/* ------------------------------------------------------------------ */

export interface FullCycleOptions {
  customerId: number;
  simulateIntent?: ReplyIntent;
  sendEmail?: boolean;
  trigger?: string;
  requestId?: string | null;
}

/**
 * 单客户完整链路：score_lead → generate_email →（发送）→ classify_reply → suggest_next_action
 * 状态变化由工具内部完成，并通过 events 表留痕。
 */
export const runFullCycle = async (
  db: Database,
  options: FullCycleOptions,
): Promise<AgentRunResult<WorkflowOutput>> => {
  const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(options.customerId);
  if (!exists) throw customerNotFound(options.customerId);

  const sendEmail = options.sendEmail ?? true;

  return executeWorkflow<WorkflowOutput>(
    db,
    {
      workflow: 'full_cycle',
      customerId: options.customerId,
      input: {
        customer_id: options.customerId,
        simulate_intent: options.simulateIntent ?? null,
        send_email: sendEmail,
      },
      trigger: options.trigger ?? 'api',
      requestId: options.requestId ?? null,
    },
    async (context, tools) => {
      const score = await tools.call<{ customer_id: number }, ScoreLeadOutput>('score_lead', {
        customer_id: options.customerId,
      });

      const email = await tools.call<{ customer_id: number; send: boolean }, GenerateEmailOutput>(
        'generate_email',
        { customer_id: options.customerId, send: sendEmail },
      );

      const classification = await tools.call<
        { customer_id: number; simulate: boolean; intent?: ReplyIntent },
        ClassifyReplyOutput
      >('classify_reply', {
        customer_id: options.customerId,
        simulate: true,
        intent: options.simulateIntent,
      });

      const nextAction = await tools.call<{ customer_id: number }, SuggestNextActionOutput>(
        'suggest_next_action',
        { customer_id: options.customerId },
      );

      const customer = await tools.call<{ customer_id: number }, ScoreLeadOutput>('score_lead', {
        customer_id: options.customerId,
      });

      const customers: FullCycleCustomerResult[] = [
        {
          customer_id: options.customerId,
          company_name: score.company_name,
          score: customer.score,
          email_id: email.email_id,
          email_subject: email.subject,
          reply_id: classification.reply_id,
          reply_body: classification.reply_body,
          intent: classification.intent,
          confidence: classification.confidence,
          needs_human: classification.needs_human,
          suggested_action: classification.suggested_action,
          from_status: email.from_status,
          to_status: classification.to_status,
          status_changed: classification.status_changed,
          next_action: nextAction.action,
          llm: {
            model: classification.model,
            provider: classification.provider,
            prompt_tokens: email.prompt_tokens + classification.prompt_tokens,
            completion_tokens: email.completion_tokens + classification.completion_tokens,
            latency_ms: email.latency_ms + classification.latency_ms,
            cost_usd: Number((email.cost_usd + classification.cost_usd).toFixed(8)),
            mock: email.mock || classification.mock,
            fallback: classification.fallback,
          },
        },
      ];

      void context;

      return {
        workflow: 'full_cycle' as WorkflowName,
        customers,
        steps: [],
        final_status: classification.to_status,
        totals: {
          customers: 1,
          emails: 1,
          replies: 1,
          intent_changes: classification.status_changed ? 1 : 0,
          tokens:
            email.prompt_tokens +
            email.completion_tokens +
            classification.prompt_tokens +
            classification.completion_tokens,
          cost_usd: Number((email.cost_usd + classification.cost_usd).toFixed(8)),
        },
      };
    },
  );
};

/* ------------------------------------------------------------------ */
/* 导入 + 生成邮件                                                     */
/* ------------------------------------------------------------------ */

export interface ImportAndDraftOptions {
  leads: z.infer<typeof importLeadsInputSchema>['leads'];
  limit?: number;
  sendEmail?: boolean;
  trigger?: string;
  requestId?: string | null;
}

export const runImportAndDraft = async (
  db: Database,
  options: ImportAndDraftOptions,
): Promise<AgentRunResult<WorkflowOutput>> =>
  executeWorkflow<WorkflowOutput>(
    db,
    {
      workflow: 'import_and_draft',
      customerId: null,
      input: {
        leads_count: options.leads.length,
        limit: options.limit ?? 1,
        send_email: options.sendEmail ?? true,
      },
      trigger: options.trigger ?? 'api',
      requestId: options.requestId ?? null,
    },
    async (_context, tools) => {
      const imported = await tools.call<
        { leads: z.infer<typeof importLeadsInputSchema>['leads']; source?: string },
        ImportLeadsOutput
      >('import_leads', { leads: options.leads, source: 'agent' });

      const customerIds = [...new Set(imported.leads.map((lead) => lead.customer_id))].slice(
        0,
        options.limit ?? 1,
      );

      const customers: FullCycleCustomerResult[] = [];
      for (const customerId of customerIds) {
        const score = await tools.call<{ customer_id: number }, ScoreLeadOutput>('score_lead', {
          customer_id: customerId,
        });
        const email = await tools.call<{ customer_id: number; send: boolean }, GenerateEmailOutput>(
          'generate_email',
          { customer_id: customerId, send: options.sendEmail ?? true },
        );
        customers.push({
          customer_id: customerId,
          company_name: score.company_name,
          score: score.score,
          email_id: email.email_id,
          email_subject: email.subject,
          reply_id: null,
          reply_body: null,
          intent: null,
          confidence: null,
          needs_human: null,
          suggested_action: null,
          from_status: email.from_status,
          to_status: email.to_status,
          status_changed: email.from_status !== email.to_status,
          next_action: null,
          llm: {
            model: email.model,
            provider: email.provider,
            prompt_tokens: email.prompt_tokens,
            completion_tokens: email.completion_tokens,
            latency_ms: email.latency_ms,
            cost_usd: email.cost_usd,
            mock: email.mock,
            fallback: false,
          },
        });
      }

      const tokens = customers.reduce(
        (sum, customer) => sum + customer.llm.prompt_tokens + customer.llm.completion_tokens,
        0,
      );
      const cost = customers.reduce((sum, customer) => sum + customer.llm.cost_usd, 0);

      return {
        workflow: 'import_and_draft' as WorkflowName,
        customers,
        steps: [],
        final_status: customers[customers.length - 1]?.to_status ?? null,
        totals: {
          customers: customers.length,
          emails: customers.length,
          replies: 0,
          intent_changes: 0,
          tokens,
          cost_usd: Number(cost.toFixed(8)),
        },
      };
    },
  );

/* ------------------------------------------------------------------ */
/* 只跑分类链路                                                        */
/* ------------------------------------------------------------------ */

export interface ClassifyOnlyOptions {
  customerId: number;
  simulateIntent?: ReplyIntent;
  trigger?: string;
  requestId?: string | null;
  body?: string;
}

export const runClassifyOnly = async (
  db: Database,
  options: ClassifyOnlyOptions,
): Promise<AgentRunResult<WorkflowOutput>> => {
  const exists = db.prepare('SELECT id FROM customers WHERE id = ?').get(options.customerId);
  if (!exists) throw customerNotFound(options.customerId);

  return executeWorkflow<WorkflowOutput>(
    db,
    {
      workflow: 'classify_only',
      customerId: options.customerId,
      input: { customer_id: options.customerId, simulate_intent: options.simulateIntent ?? null },
      trigger: options.trigger ?? 'api',
      requestId: options.requestId ?? null,
    },
    async (_context, tools) => {
      const classification = await tools.call<
        { customer_id: number; simulate: boolean; intent?: ReplyIntent; body?: string },
        ClassifyReplyOutput
      >('classify_reply', {
        customer_id: options.customerId,
        simulate: true,
        intent: options.simulateIntent,
        body: options.body,
      });

      const nextAction = await tools.call<{ customer_id: number }, SuggestNextActionOutput>(
        'suggest_next_action',
        { customer_id: options.customerId },
      );

      return {
        workflow: 'classify_only' as WorkflowName,
        customers: [
          {
            customer_id: options.customerId,
            company_name: '',
            score: 0,
            email_id: null,
            email_subject: null,
            reply_id: classification.reply_id,
            reply_body: classification.reply_body,
            intent: classification.intent,
            confidence: classification.confidence,
            needs_human: classification.needs_human,
            suggested_action: classification.suggested_action,
            from_status: classification.from_status,
            to_status: classification.to_status,
            status_changed: classification.status_changed,
            next_action: nextAction.action,
            llm: {
              model: classification.model,
              provider: classification.provider,
              prompt_tokens: classification.prompt_tokens,
              completion_tokens: classification.completion_tokens,
              latency_ms: classification.latency_ms,
              cost_usd: classification.cost_usd,
              mock: classification.mock,
              fallback: classification.fallback,
            },
          },
        ],
        steps: [],
        final_status: classification.to_status,
        totals: {
          customers: 1,
          emails: 0,
          replies: 1,
          intent_changes: classification.status_changed ? 1 : 0,
          tokens: classification.prompt_tokens + classification.completion_tokens,
          cost_usd: classification.cost_usd,
        },
      };
    },
  );
};

/* ------------------------------------------------------------------ */
/* 统一入口                                                            */
/* ------------------------------------------------------------------ */

export const runWorkflow = async (
  db: Database,
  input: WorkflowInput,
): Promise<AgentRunResult<WorkflowOutput>> => {
  switch (input.workflow) {
    case 'full_cycle': {
      if (input.customerId === undefined) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'full_cycle 工作流需要 customer_id');
      }
      return runFullCycle(db, {
        customerId: input.customerId,
        simulateIntent: input.simulateIntent,
        sendEmail: input.sendEmail,
        trigger: input.trigger,
        requestId: null,
      });
    }
    case 'import_and_draft': {
      if (!input.leads || input.leads.length === 0) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'import_and_draft 工作流需要 leads');
      }
      return runImportAndDraft(db, {
        leads: input.leads,
        limit: input.limit,
        sendEmail: input.sendEmail,
        trigger: input.trigger,
        requestId: null,
      });
    }
    case 'classify_only': {
      if (input.customerId === undefined) {
        throw new AppError(ErrorCode.VALIDATION_ERROR, 'classify_only 工作流需要 customer_id');
      }
      return runClassifyOnly(db, {
        customerId: input.customerId,
        simulateIntent: input.simulateIntent,
        trigger: input.trigger,
        requestId: null,
      });
    }
    default: {
      const exhaustive: never = input.workflow;
      throw new AppError(ErrorCode.VALIDATION_ERROR, `未知工作流: ${String(exhaustive)}`);
    }
  }
};

export interface WorkflowRunResult {
  run_id: string;
  workflow: string;
  status: 'succeeded' | 'failed';
  customer_id: number | null;
  error: string | null;
  duration_ms: number;
  started_at: string;
  finished_at: string;
  llm_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
  output: WorkflowOutput | null;
  steps: WorkflowStepSummary[];
}

/** 供路由使用：执行 + 输出摘要化 */
export const executeAndSummarize = async (
  db: Database,
  input: WorkflowInput,
): Promise<WorkflowRunResult> => {
  const result = await runWorkflow(db, input);

  const steps: WorkflowStepSummary[] = result.steps.map((step) => ({
    step_index: step.step_index,
    tool: step.tool,
    status: step.status,
    duration_ms: step.duration_ms,
    error: step.error,
    summary: describeStep(step.tool, step.output, step.error),
  }));

  const output = result.output
    ? {
        ...result.output,
        steps,
      }
    : null;

  return {
    run_id: result.run_id,
    workflow: result.workflow,
    status: result.status,
    customer_id: result.customer_id,
    error: result.error,
    duration_ms: result.duration_ms,
    started_at: result.started_at,
    finished_at: result.finished_at,
    llm_calls_count: result.llm_calls_count,
    total_tokens: result.total_tokens,
    total_cost_usd: result.total_cost_usd,
    output,
    steps,
  };
};

const describeStep = (tool: string, output: unknown, error: string | null): string => {
  if (error) return `失败：${error}`;
  const data = (output ?? {}) as Record<string, unknown>;
  switch (tool) {
    case 'import_leads':
      return `导入 ${data.imported ?? 0} 条（重复 ${data.duplicated ?? 0} 条）`;
    case 'score_lead':
      return `评分 ${data.score ?? '-'} / 100（${String(data.reason ?? '').slice(0, 60)}…）`;
    case 'generate_email':
      return `已生成邮件「${String(data.subject ?? '').slice(0, 50)}」，状态 ${data.from_status} → ${data.to_status}`;
    case 'classify_reply':
      return `意图 ${data.intent ?? '-'}（置信度 ${data.confidence ?? '-'}），状态 ${data.from_status} → ${data.to_status}`;
    case 'suggest_next_action':
      return `建议：${String(data.action ?? '').slice(0, 60)}（${data.priority ?? '-'}，${data.due_in_days ?? '-'} 天内）`;
    default:
      return '已完成';
  }
};

export const workflowService = {
  runWorkflow,
  runFullCycle,
  runImportAndDraft,
  runClassifyOnly,
  executeAndSummarize,
  WORKFLOWS,
  WORKFLOW_DESCRIPTIONS,
};

export default workflowService;
