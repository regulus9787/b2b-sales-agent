/**
 * Agent 工具定义（AGENTS.md 第 8 节）
 * 工具：import_leads / score_lead / generate_email / classify_reply / suggest_next_action
 * 每个工具有输入/输出 Zod schema，handler 只做业务编排，不直接 fetch LLM。
 */
import { z } from 'zod';
import { AppError, ErrorCode } from '../core/errors';
import { recordEvent } from '../core/events';
import { nowIso } from '../db/db';
import { importLeads, scoreLead, type LeadImportInput } from '../services/lead';
import { generateEmail } from '../services/email';
import { classifyReplyText, receiveReply, simulateCustomerReply } from '../services/reply';
import { getCustomerSummary, getLastEvent, getLastReply } from '../services/customer';
import { callLlmRaw, extractJsonObject } from '../services/llm';
import { buildNextActionMessages, nextActionSchema, type NextAction } from '../services/prompts';
import { customerStatusSchema, type CustomerStatus, type ReplyIntent } from '../core/status';
import { leadImportItemSchema } from '../schemas/lead';

/* ------------------------------------------------------------------ */
/* 输入 / 输出 schema                                                  */
/* ------------------------------------------------------------------ */

export const importLeadsInputSchema = z.object({
  leads: z.array(leadImportItemSchema).min(1).max(200),
  source: z.string().max(60).optional(),
});

export const importLeadsOutputSchema = z.object({
  imported: z.number().int(),
  duplicated: z.number().int(),
  total: z.number().int(),
  customer_ids: z.array(z.number().int()),
  leads: z.array(
    z.object({
      lead_id: z.number().int(),
      customer_id: z.number().int(),
      email: z.string(),
      company_name: z.string(),
      deduplicated: z.boolean(),
      score: z.number().int(),
      score_reason: z.string(),
      status: customerStatusSchema,
      created: z.boolean(),
    }),
  ),
});

export const scoreLeadInputSchema = z.object({
  customer_id: z.number().int().positive(),
});

export const scoreLeadOutputSchema = z.object({
  customer_id: z.number().int(),
  company_name: z.string(),
  score: z.number().int(),
  reason: z.string(),
  signals: z.array(z.string()),
  status: customerStatusSchema,
});

export const generateEmailInputSchema = z.object({
  customer_id: z.number().int().positive(),
  send: z.boolean().default(true),
  sender_name: z.string().max(120).optional(),
  pain_point: z.string().max(300).optional(),
  value_prop: z.string().max(500).optional(),
});

export const generateEmailOutputSchema = z.object({
  customer_id: z.number().int(),
  email_id: z.number().int(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['draft', 'sent']),
  model: z.string(),
  provider: z.string(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  latency_ms: z.number().int(),
  cost_usd: z.number(),
  mock: z.boolean(),
  prompt_version: z.string(),
  from_status: customerStatusSchema,
  to_status: customerStatusSchema,
});

export const classifyReplyInputSchema = z.object({
  customer_id: z.number().int().positive(),
  /** 客户回复正文；为空或 simulate=true 时自动生成模拟回复 */
  body: z.string().max(8000).optional(),
  simulate: z.boolean().default(false),
  /** 指定模拟回复的意图 */
  intent: z.enum(['interested', 'needs_info', 'rejected', 'neutral']).optional(),
  force: z.boolean().default(false),
});

export const classifyReplyOutputSchema = z.object({
  customer_id: z.number().int(),
  reply_id: z.number().int(),
  reply_body: z.string(),
  simulated: z.boolean(),
  intent: z.enum(['interested', 'needs_info', 'rejected', 'neutral']),
  confidence: z.number(),
  sentiment: z.string(),
  summary: z.string(),
  suggested_action: z.string(),
  needs_human: z.boolean(),
  model: z.string(),
  provider: z.string(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  latency_ms: z.number().int(),
  cost_usd: z.number(),
  mock: z.boolean(),
  prompt_version: z.string(),
  fallback: z.boolean(),
  from_status: customerStatusSchema,
  to_status: customerStatusSchema,
  status_changed: z.boolean(),
  status_change_error: z.string().nullable(),
});

export const suggestNextActionInputSchema = z.object({
  customer_id: z.number().int().positive(),
});

export const suggestNextActionOutputSchema = z.object({
  customer_id: z.number().int(),
  action: z.string(),
  priority: z.enum(['high', 'medium', 'low']),
  due_in_days: z.number().int(),
  reason: z.string(),
  playbook: z.array(z.string()),
  provider: z.string(),
  model: z.string(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  latency_ms: z.number().int(),
  cost_usd: z.number(),
  mock: z.boolean(),
  fallback: z.boolean(),
  error: z.string().nullable(),
});

/* ------------------------------------------------------------------ */
/* 工具类型                                                            */
/* ------------------------------------------------------------------ */

export interface ToolContext {
  db: import('better-sqlite3').Database;
  runId: string;
  requestId?: string | null;
  customerId?: number | null;
}

export interface ToolDefinition<TIn = unknown, TOut = unknown, TRaw = TIn> {
  name: string;
  description: string;
  /** 校验前的输入类型（含默认值时可缺省） */
  inputSchema: z.ZodType<TIn, z.ZodTypeDef, TRaw>;
  outputSchema: z.ZodType<TOut>;
  handler: (input: TIn, context: ToolContext) => Promise<TOut> | TOut;
}

/* ------------------------------------------------------------------ */
/* 工具实现                                                            */
/* ------------------------------------------------------------------ */

export const toolImportLeads: ToolDefinition<
  z.infer<typeof importLeadsInputSchema>,
  z.infer<typeof importLeadsOutputSchema>,
  z.input<typeof importLeadsInputSchema>
> = {
  name: 'import_leads',
  description:
    '批量导入线索：去重、评分、创建客户与线索记录，并写 lead_imported / lead_scored 事件。',
  inputSchema: importLeadsInputSchema,
  outputSchema: importLeadsOutputSchema,
  handler: (input, context) => {
    const result = importLeads(context.db, input.leads as LeadImportInput[], {
      source: input.source ?? 'agent',
      trigger: 'import_leads',
      runId: context.runId,
      requestId: context.requestId ?? null,
    });
    return importLeadsOutputSchema.parse({
      imported: result.imported,
      duplicated: result.duplicated,
      total: result.total,
      customer_ids: result.leads.map((lead) => lead.customer_id),
      leads: result.leads,
    });
  },
};

export const toolScoreLead: ToolDefinition<
  z.infer<typeof scoreLeadInputSchema>,
  z.infer<typeof scoreLeadOutputSchema>
> = {
  name: 'score_lead',
  description: '对指定客户做线索评分（规则评分 + 理由 + 信号），并写 lead_scored 事件。',
  inputSchema: scoreLeadInputSchema,
  outputSchema: scoreLeadOutputSchema,
  handler: (input, context) => {
    const customer = getCustomerSummary(context.db, input.customer_id);
    const result = scoreLead({
      industry: customer.industry,
      country: customer.country,
      company_size: customer.company_size,
      website: customer.website,
      phone: customer.phone,
      contact_name: customer.contact_name,
      notes: customer.notes,
    });

    context.db
      .prepare('UPDATE customers SET score = ?, updated_at = ? WHERE id = ?')
      .run(result.score, nowIso(), input.customer_id);

    recordEvent(context.db, {
      customerId: input.customer_id,
      eventType: 'lead_scored',
      fromStatus: customer.status,
      toStatus: customer.status,
      trigger: 'score_lead',
      runId: context.runId,
      actor: 'agent',
      payload: { score: result.score, reason: result.reason, signals: result.signals },
      requestId: context.requestId ?? null,
    });

    return scoreLeadOutputSchema.parse({
      customer_id: input.customer_id,
      company_name: customer.company_name,
      score: result.score,
      reason: result.reason,
      signals: result.signals,
      status: customer.status,
    });
  },
};

export const toolGenerateEmail: ToolDefinition<
  z.infer<typeof generateEmailInputSchema>,
  z.infer<typeof generateEmailOutputSchema>,
  z.input<typeof generateEmailInputSchema>
> = {
  name: 'generate_email',
  description:
    '基于客户画像调用 LLM 生成个性化开发信，落库并推进状态（email_drafted → contacted）。',
  inputSchema: generateEmailInputSchema,
  outputSchema: generateEmailOutputSchema,
  handler: async (input, context) => {
    const result = await generateEmail(context.db, {
      customerId: input.customer_id,
      send: input.send,
      senderName: input.sender_name,
      painPoint: input.pain_point,
      valueProp: input.value_prop,
      runId: context.runId,
      requestId: context.requestId ?? null,
      trigger: 'generate_email',
    });

    return generateEmailOutputSchema.parse({
      customer_id: result.customer_id,
      email_id: result.email_id,
      subject: result.subject,
      body: result.body,
      status: result.status,
      model: result.model,
      provider: result.provider,
      prompt_tokens: result.prompt_tokens,
      completion_tokens: result.completion_tokens,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
      mock: result.mock,
      prompt_version: result.prompt_version,
      from_status: result.from_status,
      to_status: result.to_status,
    });
  },
};

export const toolClassifyReply: ToolDefinition<
  z.infer<typeof classifyReplyInputSchema>,
  z.infer<typeof classifyReplyOutputSchema>,
  z.input<typeof classifyReplyInputSchema>
> = {
  name: 'classify_reply',
  description:
    '接收（或模拟生成）客户回复，通过 LLM 网关做意图分类，写入 replies 并推进状态（replied → 意图状态）。',
  inputSchema: classifyReplyInputSchema,
  outputSchema: classifyReplyOutputSchema,
  handler: async (input, context) => {
    let body = input.body;
    let simulated = false;

    if (!body || body.trim() === '' || input.simulate) {
      const simulatedReply = simulateCustomerReply(context.db, {
        customerId: input.customer_id,
        intent: input.intent as ReplyIntent | undefined,
      });
      body = body && body.trim() !== '' ? body : simulatedReply.body;
      simulated = true;
    }

    const result = await receiveReply(context.db, {
      customerId: input.customer_id,
      body,
      runId: context.runId,
      requestId: context.requestId ?? null,
      simulated,
      trigger: simulated ? 'simulate_reply' : 'classify_reply',
      force: input.force ?? false,
    });

    return classifyReplyOutputSchema.parse({
      customer_id: result.reply.customer_id,
      reply_id: result.reply.id,
      reply_body: result.reply.body,
      simulated,
      intent: result.classification.intent,
      confidence: result.classification.confidence,
      sentiment: result.classification.sentiment,
      summary: result.classification.summary,
      suggested_action: result.classification.suggested_action,
      needs_human: result.classification.needs_human,
      model: result.model,
      provider: result.provider,
      prompt_tokens: result.prompt_tokens,
      completion_tokens: result.completion_tokens,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
      mock: result.mock,
      prompt_version: result.prompt_version,
      fallback: result.fallback,
      from_status: result.from_status,
      to_status: result.to_status,
      status_changed: result.status_changed,
      status_change_error: result.status_change_error,
    });
  },
};

const RULE_NEXT_ACTIONS: Record<
  string,
  { action: string; priority: 'high' | 'medium' | 'low'; due_in_days: number }
> = {
  new: { action: '补全客户信息并评分（enrich）', priority: 'high', due_in_days: 1 },
  enriched: { action: '生成个性化开发信', priority: 'high', due_in_days: 1 },
  email_drafted: { action: '人工确认后发送邮件', priority: 'high', due_in_days: 1 },
  contacted: { action: '3 个工作日内发送跟进邮件', priority: 'medium', due_in_days: 3 },
  replied: { action: '立即进行意图分类并推进状态', priority: 'high', due_in_days: 1 },
  interested: { action: '24 小时内发送会议邀约', priority: 'high', due_in_days: 1 },
  needs_info: { action: '整理技术规格与报价，48 小时内回复', priority: 'high', due_in_days: 2 },
  rejected: { action: '转入长期培育，90 天后唤醒', priority: 'low', due_in_days: 90 },
  neutral: { action: '7 天后发送行业案例跟进', priority: 'medium', due_in_days: 7 },
  meeting_booked: { action: '会议前 1 天发送议程与参会人清单', priority: 'high', due_in_days: 2 },
  closed: { action: '归档并请求客户推荐', priority: 'low', due_in_days: 30 },
};

/** 规则兜底建议（LLM 失败时使用） */
export const ruleBasedNextAction = (status: string, score: number, intent: string): NextAction => {
  const base = RULE_NEXT_ACTIONS[status] ?? {
    action: '跟进客户',
    priority: 'medium' as const,
    due_in_days: 3,
  };
  return {
    action: base.action,
    priority: score >= 75 ? 'high' : base.priority,
    due_in_days: base.due_in_days,
    reason: `当前状态 ${status}，线索评分 ${score}，最近意图 ${intent}`,
    playbook:
      intent === 'interested'
        ? ['发送会议邀约', '准备行业案例 PPT', '确认参会人角色']
        : ['发送跟进邮件', '补充价值证明', '设置下次提醒'],
  };
};

export const toolSuggestNextAction: ToolDefinition<
  z.infer<typeof suggestNextActionInputSchema>,
  z.infer<typeof suggestNextActionOutputSchema>
> = {
  name: 'suggest_next_action',
  description: '基于客户状态、评分与最近意图，给出下一步最佳动作（LLM 生成，失败降级为规则建议）。',
  inputSchema: suggestNextActionInputSchema,
  outputSchema: suggestNextActionOutputSchema,
  handler: async (input, context) => {
    const customer = getCustomerSummary(context.db, input.customer_id);
    const lastEvent = getLastEvent(context.db, input.customer_id);
    const lastReply = getLastReply(context.db, input.customer_id);
    const intent = lastReply?.intent ?? 'unknown';

    const messages = buildNextActionMessages({
      company_name: customer.company_name,
      status: customer.status,
      score: customer.score,
      intent,
      last_event: lastEvent ? `${lastEvent.event_type} @ ${lastEvent.created_at}` : null,
    });

    let action: NextAction;
    let fallback = false;
    let errorMessage: string | null = null;
    let provider = 'unknown';
    let model = 'unknown';
    let promptTokens = 0;
    let completionTokens = 0;
    let latencyMs = 0;
    let costUsd = 0;
    let mock = false;

    try {
      const raw = await callLlmRaw({
        operation: 'suggest_next_action',
        runId: context.runId,
        db: context.db,
        messages: [
          { role: 'system', content: messages.system },
          { role: 'user', content: messages.user },
        ],
      });
      const parsed = nextActionSchema.safeParse(extractJsonObject(raw.content));
      if (!parsed.success) {
        throw new AppError(ErrorCode.LLM_INVALID_OUTPUT, '下一步建议输出未通过 Zod 校验', {
          details: { issues: parsed.error.issues.map((issue) => issue.message) },
        });
      }
      action = parsed.data;
      provider = raw.provider;
      model = raw.model;
      promptTokens = raw.usage.prompt_tokens;
      completionTokens = raw.usage.completion_tokens;
      latencyMs = raw.latencyMs;
      costUsd = raw.costUsd;
      mock = raw.mock;
    } catch (error) {
      fallback = true;
      errorMessage = error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      action = ruleBasedNextAction(customer.status, customer.score, intent);
    }

    return suggestNextActionOutputSchema.parse({
      customer_id: input.customer_id,
      action: action.action,
      priority: action.priority,
      due_in_days: action.due_in_days,
      reason: action.reason,
      playbook: action.playbook,
      provider,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      latency_ms: latencyMs,
      cost_usd: costUsd,
      mock,
      fallback,
      error: errorMessage,
    });
  },
};

/** 全部工具（顺序即注册顺序） */
export const ALL_TOOLS: ToolDefinition[] = [
  toolImportLeads as unknown as ToolDefinition,
  toolScoreLead as unknown as ToolDefinition,
  toolGenerateEmail as unknown as ToolDefinition,
  toolClassifyReply as unknown as ToolDefinition,
  toolSuggestNextAction as unknown as ToolDefinition,
];

/** 工具清单（前端 / 文档展示） */
export const TOOL_CATALOG = [
  { name: 'import_leads', description: toolImportLeads.description },
  { name: 'score_lead', description: toolScoreLead.description },
  { name: 'generate_email', description: toolGenerateEmail.description },
  { name: 'classify_reply', description: toolClassifyReply.description },
  { name: 'suggest_next_action', description: toolSuggestNextAction.description },
];

/** 单独暴露分类函数，便于工作流在"已有回复"场景下复用 */
export { classifyReplyText };

/** 供工作流判断状态用 */
export type { CustomerStatus };
