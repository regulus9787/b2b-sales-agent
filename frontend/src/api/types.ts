/**
 * 与后端共享的 DTO 类型（手写镜像，保持与 src/schemas 一致）
 */

export const CUSTOMER_STATUSES = [
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
] as const;

export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const REPLY_INTENTS = ['interested', 'needs_info', 'rejected', 'neutral'] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const STATUS_LABELS: Record<CustomerStatus, string> = {
  new: '新线索',
  enriched: '已补全',
  email_drafted: '邮件已起草',
  contacted: '已触达',
  replied: '已回复',
  interested: '有意向',
  needs_info: '需更多信息',
  rejected: '已拒绝',
  neutral: '中性',
  meeting_booked: '已约会议',
  closed: '已关闭',
};

export const INTENT_LABELS: Record<ReplyIntent, string> = {
  interested: '有意向',
  needs_info: '需更多信息',
  rejected: '已拒绝',
  neutral: '中性',
};

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: Pagination;
}

export interface Customer {
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

export interface CustomerSummary extends Customer {
  emails_count: number;
  replies_count: number;
  last_intent: ReplyIntent | null;
  last_event_at: string | null;
}

export interface EmailMessage {
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

export interface Reply {
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
  model: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  mock: boolean;
  from_status: CustomerStatus | null;
  to_status: CustomerStatus | null;
  created_at: string;
}

export interface SalesEvent {
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

export interface LlmCall {
  id: number;
  operation: string;
  model: string;
  provider: string;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  latency_ms: number;
  cost_usd: number;
  status: string;
  mock: boolean;
  created_at: string;
  run_id?: string | null;
}

export interface NextAction {
  action: string;
  priority: 'high' | 'medium' | 'low';
  due_in_days: number;
  reason: string;
  playbook: string[];
}

export interface CustomerDetail {
  customer: CustomerSummary;
  emails: EmailMessage[];
  replies: Reply[];
  timeline: SalesEvent[];
  events: SalesEvent[];
  llm_calls: LlmCall[];
  next_action: NextAction | null;
  allowed_transitions: CustomerStatus[];
}

export interface ImportedLead {
  lead_id: number;
  customer_id: number;
  email: string;
  company_name: string;
  deduplicated: boolean;
  score: number;
  score_reason: string;
  status: CustomerStatus;
  created: boolean;
}

export interface LeadImportResult {
  imported: number;
  duplicated: number;
  total: number;
  leads: ImportedLead[];
  customers: CustomerSummary[];
  workflow: unknown;
}

export interface EmailGenerateResult {
  customer_id: number;
  email_id: number;
  subject: string;
  body: string;
  status: 'draft' | 'sent';
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
  mock: boolean;
  prompt_version: string;
  from_status: CustomerStatus;
  to_status: CustomerStatus;
  status_changed: boolean;
}

export interface ReplyAnalyzeResult {
  customer_id: number;
  reply_id: number;
  reply_body: string;
  simulated: boolean;
  classification: {
    intent: ReplyIntent;
    confidence: number;
    sentiment: string;
    summary: string;
    suggested_action: string;
    needs_human: boolean;
  };
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
  mock: boolean;
  prompt_version: string;
  fallback: boolean;
  from_status: CustomerStatus;
  to_status: CustomerStatus;
  status_changed: boolean;
  status_change_error: string | null;
}

export interface AgentStep {
  step_index: number;
  tool: string;
  status: 'succeeded' | 'failed';
  duration_ms: number;
  error: string | null;
  summary?: string;
  input?: unknown;
  output?: unknown;
}

export interface WorkflowCustomerResult {
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
  from_status: CustomerStatus | string;
  to_status: CustomerStatus | string;
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

export interface AgentRunResult {
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
  steps: AgentStep[];
  output: {
    workflow: string;
    customers: WorkflowCustomerResult[];
    steps: AgentStep[];
    final_status: string | null;
    totals: {
      customers: number;
      emails: number;
      replies: number;
      intent_changes: number;
      tokens: number;
      cost_usd: number;
    };
  } | null;
}

export interface AgentRunDetail {
  run_id: string;
  workflow: string;
  status: 'running' | 'succeeded' | 'failed';
  trigger: string;
  customer_id: number | null;
  error: string | null;
  steps_count: number;
  llm_calls_count: number;
  total_tokens: number;
  total_cost_usd: number;
  duration_ms: number;
  started_at: string;
  finished_at: string | null;
  steps: AgentStep[];
  llm_calls: LlmCall[];
  events: SalesEvent[];
}

export interface DashboardStats {
  total_customers: number;
  by_status: { status: CustomerStatus; label: string; count: number }[];
  total_leads: number;
  total_emails: number;
  total_replies: number;
  replied_rate: number;
  interested_rate: number;
  avg_score: number;
  llm: {
    calls: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost_usd: number;
    avg_latency_ms: number;
    errors: number;
    fallbacks: number;
    mock_calls: number;
  };
  agent: { runs: number; succeeded: number; failed: number; avg_duration_ms: number };
  intents: { intent: ReplyIntent; count: number }[];
  recent_events: {
    id: number;
    customer_id: number;
    company_name: string | null;
    event_type: string;
    from_status: CustomerStatus | null;
    to_status: CustomerStatus | null;
    trigger: string;
    created_at: string;
  }[];
  funnel: { stage: string; label: string; count: number }[];
  llm_mode?: string;
  llm_model?: string;
  agent_tools?: string[];
}

export interface HealthInfo {
  status: string;
  uptime_s: number;
  version: string;
  env: string;
  database: string;
  schema_version: number;
  llm: {
    mode: 'mock' | 'live';
    provider: string;
    model: string;
    timeout_ms: number;
    max_retries: number;
  };
  agent_tools: string[];
}
