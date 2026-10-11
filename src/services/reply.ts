/**
 * 回复服务（AGENTS.md 阶段 4）
 *  - 接收客户回复文本（或生成模拟回复）
 *  - 通过 LLM 网关做意图分类（严格 JSON + Zod 校验）
 *  - 依据分类结果推进客户状态并写 events
 *  - 分类失败降级为 neutral 并记录（AGENTS.md 第 5 节）
 */
import type { Database } from 'better-sqlite3';
import { AppError, ErrorCode, customerNotFound } from '../core/errors';
import { changeCustomerStatus, recordEvent } from '../core/events';
import { isReplyIntent, type CustomerStatus, type ReplyIntent } from '../core/status';
import { nowIso } from '../db/db';
import type { CustomerRow, ReplyRow } from '../core/models';
import { toReplyDto, type ReplyDto } from '../core/models';
import { callLlmRaw, extractJsonObject } from './llm';
import { mockCustomerReply, ruleBasedIntent } from './llm-mock';
import {
  buildClassifyMessages,
  intentClassificationSchema,
  type IntentClassification,
} from './prompts';

export interface ClassifyOptions {
  runId?: string | null;
  db?: Database;
  /**
   * 覆盖 Mock 模式（默认取全局配置）。
   * 用于评估/对比脚本在同一进程内同时跑 Mock 与真实模型。
   */
  mock?: boolean;
}

export interface ClassifyOutcome {
  classification: IntentClassification;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
  mock: boolean;
  prompt_version: string;
  /** 是否走了降级路径 */
  fallback: boolean;
  error: string | null;
}

/**
 * 意图分类（唯一分类入口）
 * 失败降级：LLM_ERROR / LLM_TIMEOUT / LLM_RATE_LIMIT / LLM_INVALID_OUTPUT → neutral
 */
export const classifyReplyText = async (
  input: {
    replyText: string;
    companyName: string;
    contactName?: string | null;
    industry?: string | null;
    status: CustomerStatus | string;
    emailSubject?: string | null;
  },
  options: ClassifyOptions = {},
): Promise<ClassifyOutcome> => {
  const messages = buildClassifyMessages({
    company_name: input.companyName,
    contact_name: input.contactName,
    industry: input.industry,
    status: input.status,
    email_subject: input.emailSubject,
    reply_text: input.replyText,
  });

  try {
    const raw = await callLlmRaw({
      operation: 'classify_intent',
      runId: options.runId ?? null,
      db: options.db,
      ...(options.mock === undefined ? {} : { mock: options.mock }),
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
    });

    const parsed = extractJsonObject(raw.content);
    const validated = intentClassificationSchema.safeParse(parsed);
    if (!validated.success) {
      throw new AppError(
        ErrorCode.LLM_INVALID_OUTPUT,
        `意图分类输出未通过 Zod 校验: ${validated.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
        { details: { raw_content: raw.content.slice(0, 500) } },
      );
    }

    return {
      classification: validated.data,
      provider: raw.provider,
      model: raw.model,
      prompt_tokens: raw.usage.prompt_tokens,
      completion_tokens: raw.usage.completion_tokens,
      latency_ms: raw.latencyMs,
      cost_usd: raw.costUsd,
      mock: raw.mock,
      prompt_version: messages.version,
      fallback: false,
      error: null,
    };
  } catch (error) {
    // ---- 降级：规则分类 → neutral ----
    const message =
      error instanceof AppError
        ? `${error.code}: ${error.message}`
        : `LLM_ERROR: ${(error as Error).message}`;
    const { intent, hits } = ruleBasedIntent(input.replyText);
    const degraded: IntentClassification = {
      intent: hits > 0 ? intent : 'neutral',
      confidence: hits > 0 ? 0.5 : 0.3,
      sentiment:
        intent === 'rejected' ? 'negative' : intent === 'interested' ? 'positive' : 'neutral',
      summary: `[降级] 分类失败，使用规则兜底：${input.replyText.replace(/\s+/g, ' ').slice(0, 40)}`,
      suggested_action: '人工复核该回复并手动推进状态',
      needs_human: true,
    };

    return {
      classification: degraded,
      provider: 'fallback',
      model: 'rule-based',
      prompt_tokens: 0,
      completion_tokens: 0,
      latency_ms: 0,
      cost_usd: 0,
      mock: false,
      prompt_version: messages.version,
      fallback: true,
      error: message,
    };
  }
};

/* ------------------------------------------------------------------ */
/* 回复落库 + 状态推进                                                 */
/* ------------------------------------------------------------------ */

export interface ReceiveReplyOptions {
  customerId: number;
  body: string;
  emailMessageId?: number | null;
  runId?: string | null;
  requestId?: string | null;
  /** 是否由系统模拟生成 */
  simulated?: boolean;
  /** 触发来源 */
  trigger?: string;
  /** 是否强制刷新状态（忽略非法跳转） */
  force?: boolean;
  /** 已知的客户状态（避免重复查询） */
  knownStatus?: CustomerStatus;
}

export interface ReceiveReplyResult {
  reply: ReplyDto;
  from_status: CustomerStatus;
  to_status: CustomerStatus;
  status_changed: boolean;
  status_change_error: string | null;
  classification: IntentClassification;
  provider: string;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
  mock: boolean;
  prompt_version: string;
  fallback: boolean;
}

/**
 * 接收回复 → 分类 → 更新状态（replied → 意图对应状态）
 * 全流程写 events：reply_received、reply_classified、status_changed
 */
export const receiveReply = async (
  db: Database,
  options: ReceiveReplyOptions,
): Promise<ReceiveReplyResult> => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(options.customerId) as
    CustomerRow | undefined;
  if (!customer) throw customerNotFound(options.customerId);

  const trigger = options.trigger ?? (options.simulated ? 'simulate_reply' : 'api');
  let statusAtStart = options.knownStatus ?? customer.status;

  // 1) 若客户还没到 replied（例如 contacted），先推进到 replied
  if (statusAtStart === 'contacted') {
    const step = changeCustomerStatus({
      db,
      customerId: customer.id,
      toStatus: 'replied',
      trigger: 'receive_reply',
      runId: options.runId ?? null,
      actor: 'reply_service',
      payload: { simulated: options.simulated ?? false },
      requestId: options.requestId ?? null,
    });
    statusAtStart = step.toStatus;
  }

  const now = nowIso();

  // 2) 找关联邮件
  let emailMessageId = options.emailMessageId ?? null;
  let emailSubject: string | null = null;
  if (emailMessageId !== null) {
    const emailRow = db
      .prepare('SELECT id, subject FROM email_messages WHERE id = ?')
      .get(emailMessageId) as { id: number; subject: string } | undefined;
    emailSubject = emailRow?.subject ?? null;
  } else {
    const latest = db
      .prepare(
        "SELECT id, subject FROM email_messages WHERE customer_id = ? AND direction = 'outbound' ORDER BY id DESC LIMIT 1",
      )
      .get(customer.id) as { id: number; subject: string } | undefined;
    emailMessageId = latest?.id ?? null;
    emailSubject = latest?.subject ?? null;
  }

  // 3) 落库原始回复（先记录，保证即使分类失败也有数据）
  const replyInfo = db
    .prepare(
      `INSERT INTO replies (customer_id, email_message_id, run_id, body, classified, mock, created_at)
       VALUES (@customer_id, @email_message_id, @run_id, @body, 0, @mock, @now)`,
    )
    .run({
      customer_id: customer.id,
      email_message_id: emailMessageId,
      run_id: options.runId ?? null,
      body: options.body,
      mock: options.simulated ? 1 : 0,
      now,
    });
  const replyId = Number(replyInfo.lastInsertRowid);

  recordEvent(db, {
    customerId: customer.id,
    eventType: 'reply_received',
    fromStatus: statusAtStart,
    toStatus: statusAtStart,
    trigger,
    runId: options.runId ?? null,
    actor: 'reply_service',
    payload: {
      reply_id: replyId,
      email_message_id: emailMessageId,
      simulated: options.simulated ?? false,
      length: options.body.length,
    },
    requestId: options.requestId ?? null,
  });

  // 4) 意图分类（LLM 网关）
  const outcome = await classifyReplyText(
    {
      replyText: options.body,
      companyName: customer.company_name,
      contactName: customer.contact_name,
      industry: customer.industry,
      status: statusAtStart,
      emailSubject,
    },
    { db, runId: options.runId ?? null },
  );

  const classification = outcome.classification;
  const intent: ReplyIntent = isReplyIntent(classification.intent)
    ? classification.intent
    : 'neutral';

  db.prepare(
    `UPDATE replies SET intent = @intent, confidence = @confidence, sentiment = @sentiment,
       summary = @summary, suggested_action = @suggested_action, needs_human = @needs_human,
       classified = 1, model = @model, prompt_tokens = @prompt_tokens,
       completion_tokens = @completion_tokens, latency_ms = @latency_ms, mock = @mock,
       from_status = @from_status, to_status = @to_status
     WHERE id = @id`,
  ).run({
    id: replyId,
    intent,
    confidence: classification.confidence,
    sentiment: classification.sentiment,
    summary: classification.summary,
    suggested_action: classification.suggested_action,
    needs_human: classification.needs_human ? 1 : 0,
    model: outcome.model,
    prompt_tokens: outcome.prompt_tokens,
    completion_tokens: outcome.completion_tokens,
    latency_ms: outcome.latency_ms,
    mock: outcome.mock || options.simulated ? 1 : 0,
    from_status: statusAtStart,
    to_status: intent,
  });

  db.prepare('UPDATE customers SET last_replied_at = ?, updated_at = ? WHERE id = ?').run(
    now,
    now,
    customer.id,
  );

  recordEvent(db, {
    customerId: customer.id,
    eventType: 'reply_classified',
    fromStatus: statusAtStart,
    toStatus: statusAtStart,
    trigger: 'classify_reply',
    runId: options.runId ?? null,
    actor: 'reply_service',
    payload: {
      reply_id: replyId,
      intent,
      confidence: classification.confidence,
      sentiment: classification.sentiment,
      summary: classification.summary,
      suggested_action: classification.suggested_action,
      needs_human: classification.needs_human,
      model: outcome.model,
      provider: outcome.provider,
      fallback: outcome.fallback,
      prompt_version: outcome.prompt_version,
      prompt_tokens: outcome.prompt_tokens,
      completion_tokens: outcome.completion_tokens,
      latency_ms: outcome.latency_ms,
      cost_usd: outcome.cost_usd,
      error: outcome.error,
    },
    requestId: options.requestId ?? null,
  });

  // 5) 状态推进：replied → 意图状态
  let toStatus: CustomerStatus = statusAtStart;
  let statusChanged = false;
  let statusChangeError: string | null = null;

  if (statusAtStart === intent) {
    toStatus = statusAtStart;
  } else {
    try {
      const step = changeCustomerStatus({
        db,
        customerId: customer.id,
        toStatus: intent,
        trigger: 'classify_reply',
        runId: options.runId ?? null,
        actor: 'reply_service',
        payload: { reply_id: replyId, intent, confidence: classification.confidence },
        requestId: options.requestId ?? null,
      });
      toStatus = step.toStatus;
      statusChanged = step.changed;
    } catch (error) {
      statusChangeError =
        error instanceof AppError ? `${error.code}: ${error.message}` : String(error);
      // force=true：忽略状态机限制，强制刷新（用于人工纠偏，仍写 events 留痕）
      if (options.force) {
        db.prepare('UPDATE customers SET status = ?, updated_at = ? WHERE id = ?').run(
          intent,
          now,
          customer.id,
        );
        recordEvent(db, {
          customerId: customer.id,
          eventType: 'status_changed',
          fromStatus: statusAtStart,
          toStatus: intent,
          trigger: 'classify_reply(force)',
          runId: options.runId ?? null,
          actor: 'reply_service',
          payload: { reply_id: replyId, forced: true, original_error: statusChangeError },
          requestId: options.requestId ?? null,
        });
        toStatus = intent;
        statusChanged = true;
        statusChangeError = null;
      }
    }
  }

  const replyRow = db.prepare('SELECT * FROM replies WHERE id = ?').get(replyId) as ReplyRow;

  return {
    reply: toReplyDto(replyRow),
    from_status: options.knownStatus ?? customer.status,
    to_status: toStatus,
    status_changed: statusChanged,
    status_change_error: statusChangeError,
    classification,
    provider: outcome.provider,
    model: outcome.model,
    prompt_tokens: outcome.prompt_tokens,
    completion_tokens: outcome.completion_tokens,
    latency_ms: outcome.latency_ms,
    cost_usd: outcome.cost_usd,
    mock: outcome.mock,
    prompt_version: outcome.prompt_version,
    fallback: outcome.fallback,
  };
};

/* ------------------------------------------------------------------ */
/* 模拟客户回复                                                        */
/* ------------------------------------------------------------------ */

export interface SimulateReplyOptions {
  customerId: number;
  /** 指定意图；不传则按客户信息确定性选择 */
  intent?: ReplyIntent;
  contactName?: string | null;
  companyName?: string | null;
  senderName?: string;
}

const INTENT_CYCLE: ReplyIntent[] = ['interested', 'needs_info', 'rejected', 'neutral'];

/** 确定性意图选择（同一客户同一状态总是得到同一意图；可用 intent 参数覆盖） */
export const pickSimulatedIntent = (customerId: number, seed = 0): ReplyIntent => {
  const index = Math.abs(customerId + seed) % INTENT_CYCLE.length;
  return INTENT_CYCLE[index] as ReplyIntent;
};

/** 从客户备注/历史中推断模拟回复意图（无关键词时再退化为轮询） */
const INTENT_HINTS: { pattern: RegExp; intent: ReplyIntent }[] = [
  {
    pattern: /(预算|经费).*(用|花)(完|光)|不(需要|感兴趣)|拒绝|已有(供应商|合作)/,
    intent: 'rejected',
  },
  { pattern: /(要求|需要).*(规格|资料|文档|报价)|待补充|需更多信息/, intent: 'needs_info' },
  { pattern: /(意向|感兴趣|合作|采购|预算已批|明确需求)/, intent: 'interested' },
  { pattern: /中性|待观察|时机未到/, intent: 'neutral' },
];

/**
 * 根据客户备注推断模拟意图；没有可用线索时按 customerId 轮询（确定性）。
 */
export const inferSimulatedIntent = (
  notes: string | null | undefined,
  customerId: number,
  seed = 0,
): ReplyIntent => {
  if (notes) {
    for (const hint of INTENT_HINTS) {
      if (hint.pattern.test(notes)) return hint.intent;
    }
  }
  return pickSimulatedIntent(customerId, seed);
};

export const simulateCustomerReply = (
  db: Database,
  options: SimulateReplyOptions,
): { body: string; intent: ReplyIntent } => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(options.customerId) as
    CustomerRow | undefined;
  if (!customer) throw customerNotFound(options.customerId);

  const intent =
    options.intent ?? inferSimulatedIntent(customer.notes, customer.id, customer.score);
  const body = mockCustomerReply(intent, {
    contactName: options.contactName ?? customer.contact_name,
    companyName: options.companyName ?? customer.company_name,
    senderName: options.senderName,
  });
  return { body, intent };
};

export const listCustomerReplies = (db: Database, customerId: number, limit = 50): ReplyDto[] => {
  const rows = db
    .prepare('SELECT * FROM replies WHERE customer_id = ? ORDER BY id DESC LIMIT ?')
    .all(customerId, limit) as ReplyRow[];
  return rows.map(toReplyDto);
};

export const replyService = {
  classifyReplyText,
  receiveReply,
  simulateCustomerReply,
  pickSimulatedIntent,
  inferSimulatedIntent,
  listCustomerReplies,
};

export default replyService;
