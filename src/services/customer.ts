/**
 * 客户查询服务（列表 / 详情 / 看板统计）
 */
import type { Database } from 'better-sqlite3';
import { customerNotFound } from '../core/errors';
import {
  allowedTransitions,
  type CustomerStatus,
  STATUS_LABELS,
  CUSTOMER_STATUSES,
} from '../core/status';
import { listCustomerEvents, listStatusTimeline } from '../core/events';
import type { CustomerRow, ReplyRow, EventRow } from '../core/models';
import { toCustomerDto, type CustomerDto, type CustomerSummaryDto } from '../core/models';
import { listCustomerEmails } from './email';
import { listCustomerReplies } from './reply';
import { getLlmCallStats } from './llm-log';
import { buildPaginationMeta } from '../schemas/common';
import type { Paginated } from '../types';

export interface ListCustomersOptions {
  page?: number;
  pageSize?: number;
  status?: CustomerStatus;
  search?: string;
  minScore?: number;
  sortBy?: 'created_at' | 'updated_at' | 'score' | 'company_name';
  sortOrder?: 'asc' | 'desc';
}

interface CustomerListRow extends CustomerRow {
  emails_count: number;
  replies_count: number;
  last_intent: string | null;
  last_event_at: string | null;
}

export const listCustomers = (
  db: Database,
  options: ListCustomersOptions = {},
): Paginated<CustomerSummaryDto> => {
  const page = Math.max(1, options.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, options.pageSize ?? 20));
  const offset = (page - 1) * pageSize;

  const where: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    where.push('c.status = ?');
    params.push(options.status);
  }
  if (options.minScore !== undefined) {
    where.push('c.score >= ?');
    params.push(options.minScore);
  }
  if (options.search) {
    where.push(
      '(c.company_name LIKE ? OR c.email LIKE ? OR c.contact_name LIKE ? OR c.industry LIKE ?)',
    );
    const like = `%${options.search}%`;
    params.push(like, like, like, like);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const sortBy = options.sortBy ?? 'created_at';
  const sortOrder = (options.sortOrder ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const sortColumn = `c.${sortBy}`;

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM customers c ${whereSql}`).get(...params) as { c: number }
  ).c;

  const rows = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM email_messages e WHERE e.customer_id = c.id) AS emails_count,
              (SELECT COUNT(*) FROM replies r WHERE r.customer_id = c.id) AS replies_count,
              (SELECT r.intent FROM replies r WHERE r.customer_id = c.id AND r.intent IS NOT NULL
                 ORDER BY r.id DESC LIMIT 1) AS last_intent,
              (SELECT MAX(v.created_at) FROM events v WHERE v.customer_id = c.id) AS last_event_at
       FROM customers c
       ${whereSql}
       ORDER BY ${sortColumn} ${sortOrder}, c.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, pageSize, offset) as CustomerListRow[];

  const items: CustomerSummaryDto[] = rows.map((row) => ({
    ...toCustomerDto(row),
    emails_count: row.emails_count,
    replies_count: row.replies_count,
    last_intent: (row.last_intent ?? null) as CustomerSummaryDto['last_intent'],
    last_event_at: row.last_event_at,
  }));

  return { items, pagination: buildPaginationMeta(page, pageSize, total) };
};

export const getCustomerSummary = (db: Database, customerId: number): CustomerSummaryDto => {
  const row = db
    .prepare(
      `SELECT c.*,
              (SELECT COUNT(*) FROM email_messages e WHERE e.customer_id = c.id) AS emails_count,
              (SELECT COUNT(*) FROM replies r WHERE r.customer_id = c.id) AS replies_count,
              (SELECT r.intent FROM replies r WHERE r.customer_id = c.id AND r.intent IS NOT NULL
                 ORDER BY r.id DESC LIMIT 1) AS last_intent,
              (SELECT MAX(v.created_at) FROM events v WHERE v.customer_id = c.id) AS last_event_at
       FROM customers c WHERE c.id = ?`,
    )
    .get(customerId) as CustomerListRow | undefined;

  if (!row) throw customerNotFound(customerId);

  return {
    ...toCustomerDto(row),
    emails_count: row.emails_count,
    replies_count: row.replies_count,
    last_intent: (row.last_intent ?? null) as CustomerSummaryDto['last_intent'],
    last_event_at: row.last_event_at,
  };
};

export interface CustomerDetail {
  customer: CustomerSummaryDto;
  emails: ReturnType<typeof listCustomerEmails>;
  replies: ReturnType<typeof listCustomerReplies>;
  timeline: ReturnType<typeof listStatusTimeline>;
  events: ReturnType<typeof listCustomerEvents>;
  llm_calls: {
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
  }[];
  next_action: {
    action: string;
    priority: 'high' | 'medium' | 'low';
    due_in_days: number;
    reason: string;
    playbook: string[];
  } | null;
  allowed_transitions: readonly CustomerStatus[];
}

/** 客户详情：客户信息 + 邮件 + 回复 + 状态时间线 + LLM 调用 + 允许的下一步状态 */
export const getCustomerDetail = (db: Database, customerId: number): CustomerDetail => {
  const customer = getCustomerSummary(db, customerId);

  const emails = listCustomerEmails(db, customerId, 50);
  const replies = listCustomerReplies(db, customerId, 50);
  const timeline = listStatusTimeline(db, customerId);
  const events = listCustomerEvents(db, { customerId, limit: 200 });
  const llmCalls = listCustomerLlmCalls(db, customerId);

  const nextAction = deriveNextAction(customer, replies[0]?.intent ?? null);

  return {
    customer,
    emails,
    replies,
    timeline,
    events,
    llm_calls: llmCalls,
    next_action: nextAction,
    allowed_transitions: allowedTransitions(customer.status),
  };
};

/** 与该客户相关的 LLM 调用（通过 agent_runs、email_messages、replies 的 run_id 关联） */
export const listCustomerLlmCalls = (
  db: Database,
  customerId: number,
  limit = 50,
): CustomerDetail['llm_calls'] => {
  const runIds = new Set<string>();

  const runRows = db
    .prepare('SELECT run_id FROM agent_runs WHERE customer_id = ?')
    .all(customerId) as { run_id: string }[];
  runRows.forEach((row) => runIds.add(row.run_id));

  const emailRuns = db
    .prepare(
      'SELECT DISTINCT run_id FROM email_messages WHERE customer_id = ? AND run_id IS NOT NULL',
    )
    .all(customerId) as { run_id: string }[];
  emailRuns.forEach((row) => runIds.add(row.run_id));

  const replyRuns = db
    .prepare('SELECT DISTINCT run_id FROM replies WHERE customer_id = ? AND run_id IS NOT NULL')
    .all(customerId) as { run_id: string }[];
  replyRuns.forEach((row) => runIds.add(row.run_id));

  // 没有 run 关联时（例如直接调用 /api/email/generate/:id），退化为按时间就近展示
  const allRunIds = [...runIds].filter((id) => id && id.length > 0);
  const placeholders = allRunIds.map(() => '?').join(',');

  const selectColumns = `lc.id, lc.operation, lc.model, lc.provider, lc.prompt_tokens, lc.completion_tokens,
                         lc.total_tokens, lc.latency_ms, lc.cost_usd, lc.status, lc.mock, lc.created_at,
                         lc.run_id`;

  if (allRunIds.length === 0) {
    const rows = db
      .prepare(`SELECT ${selectColumns} FROM llm_calls lc ORDER BY lc.id DESC LIMIT ?`)
      .all(limit) as CustomerDetail['llm_calls'];
    return rows;
  }

  const rows = db
    .prepare(
      `SELECT ${selectColumns} FROM llm_calls lc
       WHERE lc.run_id IN (${placeholders})
       ORDER BY lc.id DESC LIMIT ?`,
    )
    .all(...allRunIds, limit) as CustomerDetail['llm_calls'];
  return rows;
};

/** 基于状态与最近意图的确定性建议（LLM 版本见 suggest_next_action 工具） */
export const deriveNextAction = (
  customer: CustomerDto,
  lastIntent: string | null,
): CustomerDetail['next_action'] => {
  const table: Record<
    string,
    { action: string; priority: 'high' | 'medium' | 'low'; due_in_days: number }
  > = {
    new: { action: '补全客户信息并评分', priority: 'high', due_in_days: 1 },
    enriched: { action: '生成个性化开发信', priority: 'high', due_in_days: 1 },
    email_drafted: { action: '确认邮件内容并发送', priority: 'high', due_in_days: 1 },
    contacted: { action: '3 个工作日后发送跟进邮件', priority: 'medium', due_in_days: 3 },
    replied: { action: '运行意图分类并推进状态', priority: 'high', due_in_days: 1 },
    interested: { action: '24 小时内发送会议邀约', priority: 'high', due_in_days: 1 },
    needs_info: { action: '48 小时内提供技术资料与报价', priority: 'high', due_in_days: 2 },
    rejected: { action: '转入长期培育，90 天后唤醒', priority: 'low', due_in_days: 90 },
    neutral: { action: '7 天后发送行业案例跟进', priority: 'medium', due_in_days: 7 },
    meeting_booked: { action: '会议前 1 天发送议程', priority: 'high', due_in_days: 2 },
    closed: { action: '归档并请求转介绍', priority: 'low', due_in_days: 30 },
  };

  const base = table[customer.status];
  if (!base) return null;

  return {
    ...base,
    priority: customer.score >= 75 && base.priority !== 'low' ? 'high' : base.priority,
    reason: `当前状态 ${customer.status}（${STATUS_LABELS[customer.status]}），线索评分 ${customer.score}${
      lastIntent ? `，最近意图 ${lastIntent}` : ''
    }`,
    playbook:
      customer.status === 'interested'
        ? ['发送会议邀约（含 3 个时段）', '准备行业案例与 ROI 测算', '确认参会人角色']
        : ['发送跟进邮件', '补充价值证明材料', '设置下次提醒'],
  };
};

/* ------------------------------------------------------------------ */
/* 看板统计                                                            */
/* ------------------------------------------------------------------ */

export interface DashboardStats {
  total_customers: number;
  by_status: { status: string; label: string; count: number }[];
  total_leads: number;
  total_emails: number;
  total_replies: number;
  replied_rate: number;
  interested_rate: number;
  avg_score: number;
  llm: ReturnType<typeof getLlmCallStats>;
  agent: { runs: number; succeeded: number; failed: number; avg_duration_ms: number };
  intents: { intent: string; count: number }[];
  recent_events: {
    id: number;
    customer_id: number;
    company_name: string | null;
    event_type: string;
    from_status: string | null;
    to_status: string | null;
    trigger: string;
    created_at: string;
  }[];
  funnel: { stage: string; label: string; count: number }[];
}

export const getDashboardStats = (db: Database): DashboardStats => {
  const countOf = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;

  const totalCustomers = countOf('SELECT COUNT(*) AS c FROM customers');
  const statusRows = db
    .prepare('SELECT status, COUNT(*) AS c FROM customers GROUP BY status')
    .all() as { status: string; c: number }[];
  const countByStatus = new Map(statusRows.map((row) => [row.status, row.c]));

  const byStatus = CUSTOMER_STATUSES.map((status) => ({
    status,
    label: STATUS_LABELS[status],
    count: countByStatus.get(status) ?? 0,
  }));

  const repliedOrBeyond = [
    'replied',
    'interested',
    'needs_info',
    'rejected',
    'neutral',
    'meeting_booked',
    'closed',
  ];
  const repliedCount = repliedOrBeyond.reduce(
    (sum, status) => sum + (countByStatus.get(status) ?? 0),
    0,
  );
  const interestedCount = ['interested', 'meeting_booked', 'closed'].reduce(
    (sum, status) => sum + (countByStatus.get(status) ?? 0),
    0,
  );

  const avgScoreRow = db.prepare('SELECT COALESCE(AVG(score),0) AS avg FROM customers').get() as {
    avg: number;
  };

  const agentRow = db
    .prepare(
      `SELECT COUNT(*) AS runs,
              COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),0) AS succeeded,
              COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,
              COALESCE(AVG(duration_ms),0) AS avg_duration_ms
       FROM agent_runs`,
    )
    .get() as { runs: number; succeeded: number; failed: number; avg_duration_ms: number };

  const intentRows = db
    .prepare('SELECT intent, COUNT(*) AS c FROM replies WHERE intent IS NOT NULL GROUP BY intent')
    .all() as { intent: string; c: number }[];

  const recentEvents = db
    .prepare(
      `SELECT e.id, e.customer_id, c.company_name, e.event_type, e.from_status, e.to_status,
              e.trigger, e.created_at
       FROM events e LEFT JOIN customers c ON c.id = e.customer_id
       ORDER BY e.id DESC LIMIT 15`,
    )
    .all() as DashboardStats['recent_events'];

  const funnel = [
    { stage: 'imported', label: '已导入线索', count: totalCustomers },
    {
      stage: 'contacted',
      label: '已触达',
      count: countOf(
        "SELECT COUNT(*) AS c FROM customers WHERE status NOT IN ('new','enriched','email_drafted')",
      ),
    },
    {
      stage: 'replied',
      label: '已回复',
      count: repliedCount,
    },
    {
      stage: 'interested',
      label: '有意向',
      count: interestedCount,
    },
    {
      stage: 'meeting_booked',
      label: '已约会议',
      count: countOf(
        "SELECT COUNT(*) AS c FROM customers WHERE status IN ('meeting_booked','closed')",
      ),
    },
  ];

  return {
    total_customers: totalCustomers,
    by_status: byStatus,
    total_leads: countOf('SELECT COUNT(*) AS c FROM leads'),
    total_emails: countOf('SELECT COUNT(*) AS c FROM email_messages'),
    total_replies: countOf('SELECT COUNT(*) AS c FROM replies'),
    replied_rate:
      totalCustomers === 0 ? 0 : Number(((repliedCount / totalCustomers) * 100).toFixed(1)),
    interested_rate:
      totalCustomers === 0 ? 0 : Number(((interestedCount / totalCustomers) * 100).toFixed(1)),
    avg_score: Number(avgScoreRow.avg.toFixed(1)),
    llm: getLlmCallStats(db),
    agent: {
      runs: agentRow.runs,
      succeeded: agentRow.succeeded,
      failed: agentRow.failed,
      avg_duration_ms: Math.round(agentRow.avg_duration_ms),
    },
    intents: intentRows.map((row) => ({ intent: row.intent, count: row.c })),
    recent_events: recentEvents,
    funnel,
  };
};

/** 最近一次状态变更（用于 Agent 建议） */
export const getLastEvent = (db: Database, customerId: number): EventRow | null =>
  (db
    .prepare('SELECT * FROM events WHERE customer_id = ? ORDER BY id DESC LIMIT 1')
    .get(customerId) as EventRow | undefined) ?? null;

/** 最近一条已分类回复 */
export const getLastReply = (db: Database, customerId: number): ReplyRow | null =>
  (db
    .prepare('SELECT * FROM replies WHERE customer_id = ? ORDER BY id DESC LIMIT 1')
    .get(customerId) as ReplyRow | undefined) ?? null;

export const customerService = {
  listCustomers,
  getCustomerSummary,
  getCustomerDetail,
  getDashboardStats,
  deriveNextAction,
  getLastEvent,
  getLastReply,
};

export default customerService;
