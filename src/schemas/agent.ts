/**
 * Agent 工作流相关 Zod schema
 */
import { z } from 'zod';
import { REPLY_INTENTS } from '../core/status';
import { leadImportItemSchema } from './lead';

export const workflowNames = ['full_cycle', 'import_and_draft', 'classify_only'] as const;
export const workflowNameSchema = z.enum(workflowNames);

export const agentRunBodySchema = z
  .object({
    /** 工作流名（默认 full_cycle：生成邮件 → 模拟回复 → 意图分类 → 刷新状态） */
    workflow: workflowNameSchema.default('full_cycle'),
    /** 目标客户（classify_only / full_cycle 需要） */
    customer_id: z.number().int().positive().optional(),
    /** 需要导入的线索（import_and_draft 需要） */
    leads: z.array(leadImportItemSchema).max(200).optional(),
    /** 模拟回复的意图；不传则随机（确定性）选择 */
    simulate_intent: z.enum(REPLY_INTENTS).optional(),
    /** 是否真的"发送"邮件（写 email_sent 事件），默认 true */
    send_email: z.boolean().default(true),
    /** 每个客户都跑还是只跑第一个 */
    limit: z.number().int().min(1).max(50).default(1),
    /** 调用方标识 */
    trigger: z.string().max(60).default('api'),
  })
  .refine((value) => value.customer_id !== undefined || (value.leads && value.leads.length > 0), {
    message: 'customer_id 与 leads 至少提供一个',
    path: ['customer_id'],
  });

export type AgentRunBody = z.infer<typeof agentRunBodySchema>;

export const agentStepSchema = z.object({
  step_index: z.number().int(),
  tool: z.string(),
  status: z.enum(['succeeded', 'failed']),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  duration_ms: z.number().int(),
  created_at: z.string(),
});

export const agentRunDetailSchema = z.object({
  run_id: z.string(),
  workflow: z.string(),
  status: z.enum(['running', 'succeeded', 'failed']),
  trigger: z.string(),
  customer_id: z.number().int().nullable(),
  input: z.unknown(),
  output: z.unknown(),
  error: z.string().nullable(),
  steps_count: z.number().int(),
  llm_calls_count: z.number().int(),
  total_tokens: z.number().int(),
  total_cost_usd: z.number(),
  duration_ms: z.number().int(),
  started_at: z.string(),
  finished_at: z.string().nullable(),
  steps: z.array(agentStepSchema),
  llm_calls: z.array(
    z.object({
      id: z.number().int(),
      operation: z.string(),
      provider: z.string(),
      model: z.string(),
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      total_tokens: z.number().int(),
      latency_ms: z.number().int(),
      cost_usd: z.number(),
      status: z.string(),
      attempt: z.number().int(),
      mock: z.boolean(),
      error: z.string().nullable(),
      created_at: z.string(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.number().int(),
      event_type: z.string(),
      from_status: z.string().nullable(),
      to_status: z.string().nullable(),
      trigger: z.string(),
      created_at: z.string(),
    }),
  ),
});

export type AgentRunDetail = z.infer<typeof agentRunDetailSchema>;

export const agentRunListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  customer_id: z.coerce.number().int().positive().optional(),
  status: z.enum(['running', 'succeeded', 'failed']).optional(),
});

export type AgentRunListQuery = z.infer<typeof agentRunListQuerySchema>;

export const dashboardStatsSchema = z.object({
  total_customers: z.number().int(),
  by_status: z.array(
    z.object({
      status: z.string(),
      label: z.string(),
      count: z.number().int(),
    }),
  ),
  total_leads: z.number().int(),
  total_emails: z.number().int(),
  total_replies: z.number().int(),
  replied_rate: z.number(),
  interested_rate: z.number(),
  avg_score: z.number(),
  llm: z.object({
    calls: z.number().int(),
    prompt_tokens: z.number().int(),
    completion_tokens: z.number().int(),
    total_tokens: z.number().int(),
    cost_usd: z.number(),
    avg_latency_ms: z.number().int(),
    errors: z.number().int(),
    fallbacks: z.number().int(),
    mock_calls: z.number().int(),
  }),
  agent: z.object({
    runs: z.number().int(),
    succeeded: z.number().int(),
    failed: z.number().int(),
    avg_duration_ms: z.number().int(),
  }),
  intents: z.array(
    z.object({
      intent: z.string(),
      count: z.number().int(),
    }),
  ),
  recent_events: z.array(
    z.object({
      id: z.number().int(),
      customer_id: z.number().int(),
      company_name: z.string().nullable(),
      event_type: z.string(),
      from_status: z.string().nullable(),
      to_status: z.string().nullable(),
      trigger: z.string(),
      created_at: z.string(),
    }),
  ),
  funnel: z.array(
    z.object({
      stage: z.string(),
      label: z.string(),
      count: z.number().int(),
    }),
  ),
});

export type DashboardStats = z.infer<typeof dashboardStatsSchema>;
