/**
 * 客户相关 Zod schema
 */
import { z } from 'zod';
import { CUSTOMER_STATUSES } from '../core/status';

export const customerStatusFilterSchema = z.enum(CUSTOMER_STATUSES);

export const customerQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: customerStatusFilterSchema.optional(),
  search: z.string().max(200).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  sortBy: z.enum(['created_at', 'updated_at', 'score', 'company_name']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export type CustomerQuery = z.infer<typeof customerQuerySchema>;

export const customerIdSchema = z.coerce.number().int().positive();

export const customerDtoSchema = z.object({
  id: z.number().int(),
  company_name: z.string(),
  contact_name: z.string().nullable(),
  email: z.string(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  country: z.string().nullable(),
  company_size: z.string().nullable(),
  status: z.enum(CUSTOMER_STATUSES),
  score: z.number().int(),
  source: z.string(),
  notes: z.string().nullable(),
  last_contacted_at: z.string().nullable(),
  last_replied_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const customerSummaryDtoSchema = customerDtoSchema.extend({
  emails_count: z.number().int(),
  replies_count: z.number().int(),
  last_intent: z.enum(['interested', 'needs_info', 'rejected', 'neutral']).nullable(),
  last_event_at: z.string().nullable(),
});

export const eventDtoSchema = z.object({
  id: z.number().int(),
  event_type: z.string(),
  from_status: z.enum(CUSTOMER_STATUSES).nullable(),
  to_status: z.enum(CUSTOMER_STATUSES).nullable(),
  trigger: z.string(),
  run_id: z.string().nullable(),
  actor: z.string(),
  payload: z.unknown(),
  created_at: z.string(),
});

export const emailMessageDtoSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  run_id: z.string().nullable(),
  direction: z.enum(['outbound', 'inbound']),
  subject: z.string(),
  body: z.string(),
  status: z.enum(['draft', 'sent', 'failed']),
  model: z.string().nullable(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  latency_ms: z.number().int(),
  mock: z.boolean(),
  sent_at: z.string().nullable(),
  created_at: z.string(),
});

export const replyDtoSchema = z.object({
  id: z.number().int(),
  customer_id: z.number().int(),
  email_message_id: z.number().int().nullable(),
  run_id: z.string().nullable(),
  body: z.string(),
  intent: z.enum(['interested', 'needs_info', 'rejected', 'neutral']).nullable(),
  confidence: z.number().nullable(),
  sentiment: z.string().nullable(),
  summary: z.string().nullable(),
  suggested_action: z.string().nullable(),
  needs_human: z.boolean(),
  classified: z.boolean().optional(),
  model: z.string().nullable(),
  prompt_tokens: z.number().int(),
  completion_tokens: z.number().int(),
  latency_ms: z.number().int(),
  mock: z.boolean(),
  from_status: z.enum(CUSTOMER_STATUSES).nullable(),
  to_status: z.enum(CUSTOMER_STATUSES).nullable(),
  created_at: z.string(),
});

export const customerDetailDtoSchema = z.object({
  customer: customerSummaryDtoSchema,
  emails: z.array(emailMessageDtoSchema),
  replies: z.array(replyDtoSchema),
  timeline: z.array(eventDtoSchema),
  events: z.array(eventDtoSchema),
  llm_calls: z.array(
    z.object({
      id: z.number().int(),
      operation: z.string(),
      model: z.string(),
      provider: z.string(),
      prompt_tokens: z.number().int(),
      completion_tokens: z.number().int(),
      total_tokens: z.number().int(),
      latency_ms: z.number().int(),
      cost_usd: z.number(),
      status: z.string(),
      mock: z.boolean(),
      created_at: z.string(),
      run_id: z.string().nullable().optional(),
    }),
  ),
  next_action: z
    .object({
      action: z.string(),
      priority: z.enum(['high', 'medium', 'low']),
      due_in_days: z.number().int(),
      reason: z.string(),
      playbook: z.array(z.string()),
    })
    .nullable(),
  allowed_transitions: z.array(z.enum(CUSTOMER_STATUSES)),
});
