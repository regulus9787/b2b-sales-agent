/**
 * 回复与意图分类相关 Zod schema
 */
import { z } from 'zod';
import { REPLY_INTENTS } from '../core/status';

export const analyzeReplyBodySchema = z.object({
  /** 客户回复正文（不传则使用 simulate=true 生成模拟回复） */
  body: z.string().min(1, '回复内容不能为空').max(8000).optional(),
  /** 强制指定模拟意图（配合 simulate 使用） */
  intent: z.enum(REPLY_INTENTS).optional(),
  /** 没有 body 时自动生成模拟客户回复 */
  simulate: z.boolean().default(false),
  /** 关联的邮件 ID（可选，默认取最近一封 outbound 邮件） */
  email_message_id: z.number().int().positive().optional(),
  run_id: z.string().max(64).optional(),
  /** 是否强制刷新客户状态（即使当前状态不允许跳转，也记录分类结果） */
  force: z.boolean().default(false),
});

export type AnalyzeReplyBody = z.infer<typeof analyzeReplyBodySchema>;

export const intentClassificationResultSchema = z.object({
  intent: z.enum(REPLY_INTENTS),
  confidence: z.number(),
  sentiment: z.string(),
  summary: z.string(),
  suggested_action: z.string(),
  needs_human: z.boolean(),
});

export const analyzeReplyResultSchema = z.object({
  customer_id: z.number().int(),
  reply_id: z.number().int(),
  reply_body: z.string(),
  simulated: z.boolean(),
  classification: intentClassificationResultSchema,
  provider: z.string(),
  model: z.string(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  latency_ms: z.number().int(),
  cost_usd: z.number(),
  mock: z.boolean(),
  prompt_version: z.string(),
  fallback: z.boolean(),
  from_status: z.enum([
    'new',
    'enriched',
    'email_drafted',
    'contacted',
    'replied',
    'interested',
    'needs_info',
    'rejected',
    'neutral',
    'meeting_booked',
    'closed',
  ]),
  to_status: z.enum([
    'new',
    'enriched',
    'email_drafted',
    'contacted',
    'replied',
    'interested',
    'needs_info',
    'rejected',
    'neutral',
    'meeting_booked',
    'closed',
  ]),
  status_changed: z.boolean(),
  status_change_error: z.string().nullable(),
});

export type AnalyzeReplyResult = z.infer<typeof analyzeReplyResultSchema>;
