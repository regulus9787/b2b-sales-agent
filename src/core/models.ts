/**
 * 领域模型：数据库行类型 + 行 → DTO 映射
 */
import type { CustomerStatus, ReplyIntent } from '../core/status';

export interface LeadRow {
  id: number;
  company_name: string;
  contact_name: string | null;
  email: string;
  phone: string | null;
  website: string | null;
  industry: string | null;
  country: string | null;
  company_size: string | null;
  source: string;
  notes: string | null;
  raw_payload: string | null;
  score: number;
  score_reason: string | null;
  dedupe_hash: string;
  customer_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerRow {
  id: number;
  company_name: string;
  contact_name: string | null;
  email: string;
  phone: string | null;
  website: string | null;
  industry: string | null;
  country: string | null;
  company_size: string | null;
  status: CustomerStatus;
  score: number;
  source: string;
  notes: string | null;
  last_contacted_at: string | null;
  last_replied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailMessageRow {
  id: number;
  customer_id: number;
  lead_id: number | null;
  run_id: string | null;
  direction: 'outbound' | 'inbound';
  subject: string;
  body: string;
  status: 'draft' | 'sent' | 'failed';
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  mock: number;
  provider_message_id: string | null;
  sent_at: string | null;
  created_at: string;
}

export interface ReplyRow {
  id: number;
  customer_id: number;
  email_message_id: number | null;
  run_id: string | null;
  body: string;
  intent: ReplyIntent | null;
  confidence: number | null;
  sentiment: string | null;
  summary: string | null;
  suggested_action: string | null;
  needs_human: number;
  classified: number;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  mock: number;
  from_status: CustomerStatus | null;
  to_status: CustomerStatus | null;
  created_at: string;
}

export interface EventRow {
  id: number;
  customer_id: number;
  event_type: string;
  from_status: CustomerStatus | null;
  to_status: CustomerStatus | null;
  trigger: string;
  run_id: string | null;
  actor: string;
  payload: string | null;
  request_id: string | null;
  created_at: string;
}

export interface AgentRunRow {
  id: number;
  run_id: string;
  workflow: string;
  status: 'running' | 'succeeded' | 'failed';
  trigger: string;
  customer_id: number | null;
  input: string | null;
  output: string | null;
  error: string | null;
  steps_count: number;
  llm_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  request_id: string | null;
  started_at: string;
  finished_at: string | null;
  created_at: string;
}

export interface AgentRunStepRow {
  id: number;
  run_id: string;
  step_index: number;
  tool: string;
  status: 'succeeded' | 'failed';
  input: string | null;
  output: string | null;
  error: string | null;
  duration_ms: number;
  created_at: string;
}

export interface CustomerDto {
  id: number;
  company_name: string;
  contact_name: string | null;
  email: string;
  phone: string | null;
  website: string | null;
  industry: string | null;
  country: string | null;
  company_size: string | null;
  status: CustomerStatus;
  score: number;
  source: string;
  notes: string | null;
  last_contacted_at: string | null;
  last_replied_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomerSummaryDto extends CustomerDto {
  emails_count: number;
  replies_count: number;
  last_intent: ReplyIntent | null;
  last_event_at: string | null;
}

export interface EventDto {
  id: number;
  event_type: string;
  from_status: CustomerStatus | null;
  to_status: CustomerStatus | null;
  trigger: string;
  run_id: string | null;
  actor: string;
  payload: unknown;
  created_at: string;
}

export interface EmailMessageDto {
  id: number;
  customer_id: number;
  run_id: string | null;
  direction: 'outbound' | 'inbound';
  subject: string;
  body: string;
  status: 'draft' | 'sent' | 'failed';
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  mock: boolean;
  sent_at: string | null;
  created_at: string;
}

export interface ReplyDto {
  id: number;
  customer_id: number;
  email_message_id: number | null;
  run_id: string | null;
  body: string;
  intent: ReplyIntent | null;
  confidence: number | null;
  sentiment: string | null;
  summary: string | null;
  suggested_action: string | null;
  needs_human: boolean;
  /** 是否已完成意图分类 */
  classified: boolean;
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  mock: boolean;
  from_status: CustomerStatus | null;
  to_status: CustomerStatus | null;
  created_at: string;
}

export interface LlmCallDto {
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
  mock: boolean;
  error: string | null;
  created_at: string;
}

const safeJson = (value: string | null): unknown => {
  if (value === null || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

export const toCustomerDto = (row: CustomerRow): CustomerDto => ({
  id: row.id,
  company_name: row.company_name,
  contact_name: row.contact_name,
  email: row.email,
  phone: row.phone,
  website: row.website,
  industry: row.industry,
  country: row.country,
  company_size: row.company_size,
  status: row.status,
  score: row.score,
  source: row.source,
  notes: row.notes,
  last_contacted_at: row.last_contacted_at,
  last_replied_at: row.last_replied_at,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

export const toEventDto = (row: EventRow): EventDto => ({
  id: row.id,
  event_type: row.event_type,
  from_status: row.from_status,
  to_status: row.to_status,
  trigger: row.trigger,
  run_id: row.run_id,
  actor: row.actor,
  payload: safeJson(row.payload),
  created_at: row.created_at,
});

export const toEmailMessageDto = (row: EmailMessageRow): EmailMessageDto => ({
  id: row.id,
  customer_id: row.customer_id,
  run_id: row.run_id,
  direction: row.direction,
  subject: row.subject,
  body: row.body,
  status: row.status,
  model: row.model,
  prompt_tokens: row.prompt_tokens,
  completion_tokens: row.completion_tokens,
  latency_ms: row.latency_ms,
  mock: row.mock === 1,
  sent_at: row.sent_at,
  created_at: row.created_at,
});

export const toReplyDto = (row: ReplyRow): ReplyDto => ({
  id: row.id,
  customer_id: row.customer_id,
  email_message_id: row.email_message_id,
  run_id: row.run_id,
  body: row.body,
  intent: row.intent,
  confidence: row.confidence,
  sentiment: row.sentiment,
  summary: row.summary,
  suggested_action: row.suggested_action,
  needs_human: row.needs_human === 1,
  classified: row.classified === 1,
  model: row.model,
  prompt_tokens: row.prompt_tokens,
  completion_tokens: row.completion_tokens,
  latency_ms: row.latency_ms,
  mock: row.mock === 1,
  from_status: row.from_status,
  to_status: row.to_status,
  created_at: row.created_at,
});

export const toLlmCallDto = (row: LlmCallRecordLike): LlmCallDto => ({
  id: row.id,
  run_id: row.run_id,
  provider: row.provider,
  model: row.model,
  operation: row.operation,
  prompt_tokens: row.prompt_tokens,
  completion_tokens: row.completion_tokens,
  total_tokens: row.total_tokens,
  latency_ms: row.latency_ms,
  cost_usd: row.cost_usd,
  status: row.status,
  attempt: row.attempt,
  mock: row.mock === 1,
  error: row.error,
  created_at: row.created_at,
});

interface LlmCallRecordLike {
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
