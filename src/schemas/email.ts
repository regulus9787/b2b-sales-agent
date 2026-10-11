/**
 * 邮件相关 Zod schema
 */
import { z } from 'zod';

export const generateEmailBodySchema = z.object({
  /** 覆盖发件人姓名（可选） */
  sender_name: z.string().max(120).optional(),
  /** 自定义痛点（不传则用行业库） */
  pain_point: z.string().max(300).optional(),
  /** 自定义价值主张 */
  value_prop: z.string().max(500).optional(),
  /** 语言偏好 */
  language: z.string().max(60).optional(),
  /** 生成后是否自动标记为已发送（默认 true：模拟发送） */
  send: z.boolean().default(true),
  /** 关联的 Agent run */
  run_id: z.string().max(64).optional(),
});

export type GenerateEmailBody = z.infer<typeof generateEmailBodySchema>;

export const generateEmailResultSchema = z.object({
  customer_id: z.number().int(),
  email_id: z.number().int(),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['draft', 'sent']),
  provider: z.string(),
  model: z.string(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  latency_ms: z.number().int(),
  cost_usd: z.number(),
  mock: z.boolean(),
  prompt_version: z.string(),
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
});

export type GenerateEmailResult = z.infer<typeof generateEmailResultSchema>;
