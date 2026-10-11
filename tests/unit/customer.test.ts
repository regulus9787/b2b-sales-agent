/**
 * 单元测试：客户查询与看板统计（src/services/customer.ts）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/db';
import { seedDatabase } from '../../src/db/seed';
import {
  deriveNextAction,
  getCustomerDetail,
  getCustomerSummary,
  getDashboardStats,
  getLastEvent,
  getLastReply,
  listCustomers,
} from '../../src/services/customer';
import { generateEmail } from '../../src/services/email';
import { receiveReply } from '../../src/services/reply';
import { customerIdByStatus } from '../helpers/testDb';
import { toCustomerDto } from '../../src/core/models';

let db: Database;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  seedDatabase(db, { silent: true });
});

afterEach(() => {
  db.close();
});

describe('customer 服务 · 列表与过滤', () => {
  it('默认分页返回全部 seed 客户', () => {
    const result = listCustomers(db, { page: 1, pageSize: 20 });
    expect(result.items.length).toBe(10);
    expect(result.pagination.total).toBe(10);
    expect(result.pagination.totalPages).toBe(1);
  });

  it('支持状态过滤', () => {
    const result = listCustomers(db, { status: 'interested' });
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.every((item) => item.status === 'interested')).toBe(true);
  });

  it('支持搜索（公司名 / 邮箱 / 行业）', () => {
    const result = listCustomers(db, { search: 'Nova' });
    expect(result.items.length).toBe(1);
    expect(result.items[0]?.company_name).toContain('Nova');
  });

  it('支持 minScore 过滤与排序', () => {
    const high = listCustomers(db, { minScore: 80, sortBy: 'score', sortOrder: 'desc' });
    expect(high.items.every((item) => item.score >= 80)).toBe(true);

    const sorted = listCustomers(db, { sortBy: 'score', sortOrder: 'desc', pageSize: 100 });
    const scores = sorted.items.map((item) => item.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('分页参数越界时被夹紧', () => {
    const result = listCustomers(db, { page: 0, pageSize: 1000 });
    expect(result.pagination.page).toBe(1);
    expect(result.pagination.pageSize).toBe(100);
  });

  it('列表项带邮件/回复计数与最近意图字段', () => {
    const result = listCustomers(db, { pageSize: 1 });
    const item = result.items[0];
    expect(item).toBeDefined();
    expect(typeof item?.emails_count).toBe('number');
    expect(typeof item?.replies_count).toBe('number');
    expect(item?.last_intent === null || typeof item?.last_intent === 'string').toBe(true);
  });
});

describe('customer 服务 · 详情', () => {
  it('返回客户、邮件、回复、时间线、LLM 调用与允许的跳转', async () => {
    const customerId = customerIdByStatus(db, 'new');
    await generateEmail(db, { customerId, send: true });
    await receiveReply(db, { customerId, body: '我们对方案很感兴趣，能否安排演示？' });

    const detail = getCustomerDetail(db, customerId);
    expect(detail.customer.id).toBe(customerId);
    expect(detail.emails.length).toBe(1);
    expect(detail.replies.length).toBe(1);
    expect(detail.timeline.length).toBeGreaterThan(0);
    expect(detail.events.length).toBeGreaterThan(0);
    expect(detail.llm_calls.length).toBeGreaterThan(0);
    expect(detail.next_action).not.toBeNull();
    expect(Array.isArray(detail.allowed_transitions)).toBe(true);
  });

  it('客户不存在抛 CUSTOMER_NOT_FOUND', () => {
    expect(() => getCustomerDetail(db, 999999)).toThrowError(/客户不存在/);
    expect(() => getCustomerSummary(db, 999999)).toThrowError(/客户不存在/);
  });

  it('deriveNextAction 覆盖多种状态且优先级随分数变化', () => {
    const base = toCustomerDto({
      id: 1,
      company_name: 'X',
      contact_name: null,
      email: 'x@y.z',
      phone: null,
      website: null,
      industry: null,
      country: null,
      company_size: null,
      status: 'new',
      score: 90,
      source: 'test',
      notes: null,
      last_contacted_at: null,
      last_replied_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    expect(deriveNextAction(base, null)?.action).toContain('补全');
    expect(
      deriveNextAction({ ...base, status: 'interested', score: 90 }, 'interested')?.priority,
    ).toBe('high');
    expect(deriveNextAction({ ...base, status: 'rejected', score: 20 }, 'rejected')?.priority).toBe(
      'low',
    );
    expect(deriveNextAction({ ...base, status: 'meeting_booked' }, null)?.due_in_days).toBe(2);
  });
});

describe('customer 服务 · 看板统计', () => {
  it('统计总数、状态分布与漏斗', async () => {
    const customerId = customerIdByStatus(db, 'new');
    await generateEmail(db, { customerId, send: true });
    await receiveReply(db, { customerId, body: '很感兴趣，安排演示吧' });

    const stats = getDashboardStats(db);
    expect(stats.total_customers).toBe(10);
    expect(stats.total_leads).toBe(10);
    expect(stats.total_emails).toBeGreaterThanOrEqual(1);
    expect(stats.total_replies).toBeGreaterThanOrEqual(1);
    expect(stats.by_status.length).toBe(11);
    expect(stats.funnel.length).toBe(5);
    expect(stats.replied_rate).toBeGreaterThan(0);
    expect(stats.avg_score).toBeGreaterThan(0);
  });

  it('LLM 与 Agent 指标随调用增长', async () => {
    const before = getDashboardStats(db);
    const customerId = customerIdByStatus(db, 'new');
    await generateEmail(db, { customerId, send: true });
    const after = getDashboardStats(db);

    expect(after.llm.calls).toBeGreaterThan(before.llm.calls);
    expect(after.llm.total_tokens).toBeGreaterThan(before.llm.total_tokens);
    expect(after.llm.avg_latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('最近事件带公司名', () => {
    const stats = getDashboardStats(db);
    expect(stats.recent_events.length).toBeGreaterThan(0);
    expect(stats.recent_events[0]?.company_name).toBeTruthy();
  });

  it('getLastEvent / getLastReply 返回最新记录', async () => {
    const customerId = customerIdByStatus(db, 'new');
    await generateEmail(db, { customerId, send: true });
    expect(getLastEvent(db, customerId)).not.toBeNull();
    expect(getLastReply(db, customerId)).toBeNull();

    await receiveReply(db, { customerId, body: '请发报价单' });
    expect(getLastReply(db, customerId)?.intent).toBe('needs_info');
  });
});
