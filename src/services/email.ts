/**
 * 邮件服务（AGENTS.md 阶段 4）
 *  - 基于客户画像调用 LLM 网关生成个性化开发信
 *  - 落库 email_messages，并推进状态 email_drafted（发送后 → contacted）
 *  - 所有 LLM 调用均通过 services/llm.ts，路由层不直接 fetch
 */
import type { Database } from 'better-sqlite3';
import config from '../config';
import { AppError, ErrorCode, customerNotFound } from '../core/errors';
import { changeCustomerStatus, recordEvent } from '../core/events';
import type { CustomerStatus } from '../core/status';
import { nowIso } from '../db/db';
import type { CustomerRow, EmailMessageRow } from '../core/models';
import { toEmailMessageDto, type EmailMessageDto } from '../core/models';
import { callLlmRaw } from './llm';
import { buildEmailMessages, parseEmailDraft, SENDER_DEFAULTS, type EmailDraft } from './prompts';

export interface GenerateEmailOptions {
  customerId: number;
  /** 生成后模拟发送 */
  send?: boolean;
  senderName?: string;
  painPoint?: string;
  valueProp?: string;
  language?: string;
  runId?: string | null;
  requestId?: string | null;
  trigger?: string;
  /** 允许重复生成（默认 true） */
  allowRegenerate?: boolean;
}

export interface GenerateEmailResult {
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
  /** 供 Agent 工作流使用的附件信息 */
  draft: EmailDraft;
}

export const getCustomerRowOrThrow = (db: Database, customerId: number): CustomerRow => {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId) as
    CustomerRow | undefined;
  if (!row) throw customerNotFound(customerId);
  return row;
};

export const getLatestOutboundEmail = (
  db: Database,
  customerId: number,
): EmailMessageDto | null => {
  const row = db
    .prepare(
      "SELECT * FROM email_messages WHERE customer_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1",
    )
    .get(customerId) as EmailMessageRow | undefined;
  return row ? toEmailMessageDto(row) : null;
};

export const listCustomerEmails = (
  db: Database,
  customerId: number,
  limit = 50,
): EmailMessageDto[] => {
  const rows = db
    .prepare('SELECT * FROM email_messages WHERE customer_id = ? ORDER BY id DESC LIMIT ?')
    .all(customerId, limit) as EmailMessageRow[];
  return rows.map(toEmailMessageDto);
};

/**
 * 生成个性化开发信（LLM 网关调用）。
 * 状态推进：new/enriched → email_drafted（send=true 时继续 → contacted）
 */
export const generateEmail = async (
  db: Database,
  options: GenerateEmailOptions,
): Promise<GenerateEmailResult> => {
  const customer = getCustomerRowOrThrow(db, options.customerId);
  const send = options.send ?? true;
  const trigger = options.trigger ?? 'api';

  const messages = buildEmailMessages({
    company_name: customer.company_name,
    contact_name: customer.contact_name,
    industry: customer.industry,
    country: customer.country,
    company_size: customer.company_size,
    website: customer.website,
    score: customer.score,
    pain_point: options.painPoint ?? null,
    value_prop: options.valueProp ?? null,
    sender_name: options.senderName ?? SENDER_DEFAULTS.name,
    sender_company: SENDER_DEFAULTS.company,
    language: options.language ?? '中文为主，保留英文专业术语',
  });

  const llmResult = await callLlmRaw({
    operation: 'generate_email',
    runId: options.runId ?? null,
    db,
    messages: [
      { role: 'system', content: messages.system },
      { role: 'user', content: messages.user },
    ],
  });

  let draft: EmailDraft;
  try {
    draft = parseEmailDraft(llmResult.content);
  } catch (error) {
    throw new AppError(
      ErrorCode.LLM_INVALID_OUTPUT,
      `LLM 邮件输出解析失败: ${(error as Error).message}`,
      {
        details: { raw_content: llmResult.content.slice(0, 500) },
      },
    );
  }

  const now = nowIso();
  const initialStatus = send ? 'sent' : 'draft';
  const insertEmail = db.prepare(`
    INSERT INTO email_messages (customer_id, lead_id, run_id, direction, subject, body, status, model,
                               prompt_tokens, completion_tokens, latency_ms, mock, provider_message_id,
                               sent_at, created_at)
    VALUES (@customer_id, @lead_id, @run_id, 'outbound', @subject, @body, @status, @model,
            @prompt_tokens, @completion_tokens, @latency_ms, @mock, @provider_message_id, @sent_at, @now)
  `);

  const leadRow = db
    .prepare('SELECT id FROM leads WHERE customer_id = ? ORDER BY id ASC LIMIT 1')
    .get(customer.id) as { id: number } | undefined;

  const emailInfo = insertEmail.run({
    customer_id: customer.id,
    lead_id: leadRow?.id ?? null,
    run_id: options.runId ?? null,
    subject: draft.subject,
    body: draft.body,
    status: initialStatus,
    model: llmResult.model,
    prompt_tokens: llmResult.usage.prompt_tokens,
    completion_tokens: llmResult.usage.completion_tokens,
    latency_ms: llmResult.latencyMs,
    mock: llmResult.mock ? 1 : 0,
    provider_message_id: `mock-${Date.now()}-${customer.id}`,
    sent_at: send ? now : null,
    now,
  });
  const emailId = Number(emailInfo.lastInsertRowid);

  /* -------- 状态推进 -------- */
  let fromStatus = customer.status;
  let changed = false;

  recordEvent(db, {
    customerId: customer.id,
    eventType: 'email_generated',
    fromStatus,
    toStatus: fromStatus,
    trigger,
    runId: options.runId ?? null,
    actor: 'email_service',
    payload: {
      email_id: emailId,
      subject: draft.subject,
      model: llmResult.model,
      prompt_version: messages.version,
      prompt_tokens: llmResult.usage.prompt_tokens,
      completion_tokens: llmResult.usage.completion_tokens,
      latency_ms: llmResult.latencyMs,
      cost_usd: llmResult.costUsd,
      mock: llmResult.mock,
    },
    requestId: options.requestId ?? null,
  });

  // new → enriched（生成邮件隐含信息已补全）
  if (fromStatus === 'new') {
    const step = changeCustomerStatus({
      db,
      customerId: customer.id,
      toStatus: 'enriched',
      trigger: 'generate_email',
      runId: options.runId ?? null,
      actor: 'email_service',
      payload: { reason: '生成开发信前自动补全客户信息' },
      requestId: options.requestId ?? null,
    });
    fromStatus = step.toStatus;
    changed = true;
  }

  if (fromStatus === 'enriched') {
    const step = changeCustomerStatus({
      db,
      customerId: customer.id,
      toStatus: 'email_drafted',
      trigger: 'generate_email',
      runId: options.runId ?? null,
      actor: 'email_service',
      payload: { email_id: emailId },
      requestId: options.requestId ?? null,
    });
    fromStatus = step.toStatus;
    changed = true;
  }

  if (send && fromStatus === 'email_drafted') {
    const step = changeCustomerStatus({
      db,
      customerId: customer.id,
      toStatus: 'contacted',
      trigger: 'send_email',
      runId: options.runId ?? null,
      actor: 'email_service',
      payload: { email_id: emailId, channel: 'email', mock: llmResult.mock },
      requestId: options.requestId ?? null,
    });
    fromStatus = step.toStatus;
    changed = true;

    db.prepare('UPDATE customers SET last_contacted_at = ? WHERE id = ?').run(now, customer.id);
    recordEvent(db, {
      customerId: customer.id,
      eventType: 'email_sent',
      fromStatus: 'email_drafted',
      toStatus: 'contacted',
      trigger: 'send_email',
      runId: options.runId ?? null,
      actor: 'email_service',
      payload: { email_id: emailId, provider_message_id: `mock-${emailId}` },
      requestId: options.requestId ?? null,
    });
  } else if (send && fromStatus !== 'contacted') {
    // 已是 contacted/replied 等状态：仅记录发送事件，不做非法跳转
    recordEvent(db, {
      customerId: customer.id,
      eventType: 'email_sent',
      fromStatus,
      toStatus: fromStatus,
      trigger: 'send_email',
      runId: options.runId ?? null,
      actor: 'email_service',
      payload: { email_id: emailId, note: '客户已处于后续状态，仅追加发送记录' },
    });
  }

  return {
    customer_id: customer.id,
    email_id: emailId,
    subject: draft.subject,
    body: draft.body,
    status: initialStatus,
    provider: llmResult.provider,
    model: llmResult.model,
    prompt_tokens: llmResult.usage.prompt_tokens,
    completion_tokens: llmResult.usage.completion_tokens,
    latency_ms: llmResult.latencyMs,
    cost_usd: llmResult.costUsd,
    mock: llmResult.mock,
    prompt_version: messages.version,
    from_status: customer.status,
    to_status: fromStatus,
    status_changed: changed,
    draft,
  };
};

export const emailService = {
  generateEmail,
  listCustomerEmails,
  getLatestOutboundEmail,
  isMockMode: (): boolean => config.llm.mock,
};

export default emailService;
