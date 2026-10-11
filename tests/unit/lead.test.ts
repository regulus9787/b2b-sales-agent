/**
 * 单元测试：线索服务（src/services/lead.ts）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/db';
import {
  HIGH_VALUE_INDUSTRIES,
  dedupeHash,
  getCustomerByEmail,
  getLeadById,
  importLeads,
  listLeads,
  normalizeKey,
  rescoreLead,
  scoreLead,
  statusForScore,
} from '../../src/services/lead';
import { AppError, ErrorCode } from '../../src/core/errors';

let db: Database;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
});

afterEach(() => {
  db.close();
});

const lead = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  company_name: 'Acme Robotics GmbH',
  contact_name: 'Hans Weber',
  email: 'hans.weber@acme-robotics.example.com',
  industry: '工业机器人',
  country: 'DE',
  company_size: '100-500',
  website: 'https://acme-robotics.example.com',
  phone: '+49-30-1111-2222',
  notes: '展会收集，有明确采购需求',
  ...overrides,
});

describe('lead 服务 · 评分', () => {
  it('高价值行业 + 大团队 + 目标市场得到较高分', () => {
    const high = scoreLead({
      industry: HIGH_VALUE_INDUSTRIES[0],
      country: 'CN',
      company_size: '1000+',
      website: 'https://x.example.com',
      phone: '+86-10-1',
      contact_name: 'A',
      notes: '有明确采购需求与预算',
    });
    expect(high.score).toBeGreaterThanOrEqual(80);
    expect(high.reason).toContain('等级 A');
    expect(high.signals.length).toBeGreaterThan(3);
  });

  it('信息缺失时得分较低', () => {
    const low = scoreLead({});
    expect(low.score).toBeLessThan(50);
    expect(low.reason).toContain('等级 D');
  });

  it('分数被限制在 0-100', () => {
    const result = scoreLead({
      industry: HIGH_VALUE_INDUSTRIES[0],
      country: 'CN',
      company_size: '1000+',
      website: 'https://x.example.com',
      phone: '1',
      contact_name: 'A',
      notes: '需求意向采购预算合作',
    });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it('statusForScore：>=70 直接 enriched，其余 new', () => {
    expect(statusForScore(70)).toBe('enriched');
    expect(statusForScore(69)).toBe('new');
  });

  it('normalizeKey / dedupeHash 稳定且区分大小写与空格', () => {
    expect(normalizeKey('  Acme   Robotics ')).toBe('acme robotics');
    expect(dedupeHash('A@B.com', 'Acme')).toBe(dedupeHash('a@b.com', ' acme '));
    expect(dedupeHash('a@b.com', 'Acme')).not.toBe(dedupeHash('a@b.com', 'Other'));
  });
});

describe('lead 服务 · 导入与去重', () => {
  it('导入单条线索：创建客户 + 线索 + 事件', () => {
    const result = importLeads(db, [lead() as never], { source: 'test' });
    expect(result.imported).toBe(1);
    expect(result.duplicated).toBe(0);
    expect(result.leads).toHaveLength(1);

    const created = result.leads[0];
    expect(created?.deduplicated).toBe(false);
    expect(created?.score).toBeGreaterThan(0);

    const events = db
      .prepare('SELECT event_type FROM events WHERE customer_id = ? ORDER BY id')
      .all(created?.customer_id) as { event_type: string }[];
    expect(events.map((event) => event.event_type)).toContain('lead_imported');
    expect(events.map((event) => event.event_type)).toContain('lead_scored');
  });

  it('重复导入同一线索：duplicated 计数且不重复建客户', () => {
    importLeads(db, [lead() as never]);
    const second = importLeads(db, [lead() as never]);
    expect(second.imported).toBe(0);
    expect(second.duplicated).toBe(1);
    expect(second.leads[0]?.deduplicated).toBe(true);

    const customers = db.prepare('SELECT COUNT(*) AS c FROM customers').get() as { c: number };
    expect(customers.c).toBe(1);
  });

  it('批量导入统计正确', () => {
    const result = importLeads(db, [
      lead({ email: 'a@x.example.com', company_name: 'A Co' }) as never,
      lead({ email: 'b@x.example.com', company_name: 'B Co' }) as never,
      lead({ email: 'a@x.example.com', company_name: 'A Co' }) as never, // 同批内重复
    ]);
    expect(result.total).toBe(3);
    expect(result.imported).toBe(2);
    expect(result.duplicated).toBe(1);
  });

  it('空数组抛 VALIDATION_ERROR', () => {
    expect(() => importLeads(db, [])).toThrowError(AppError);
    try {
      importLeads(db, []);
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCode.VALIDATION_ERROR);
    }
  });

  it('非法邮箱抛 VALIDATION_ERROR 且带字段级 details', () => {
    try {
      importLeads(db, [lead({ email: 'not-an-email' }) as never]);
      throw new Error('应当抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(JSON.stringify(appError.details)).toContain('email');
    }
  });

  it('显式传入 score 时使用给定分数', () => {
    const result = importLeads(db, [lead({ score: 12 }) as never]);
    expect(result.leads[0]?.score).toBe(12);
    expect(result.leads[0]?.status).toBe('new');
  });

  it('getCustomerByEmail 命中/未命中', () => {
    importLeads(db, [lead() as never]);
    expect(getCustomerByEmail(db, 'hans.weber@acme-robotics.example.com')?.company_name).toBe(
      'Acme Robotics GmbH',
    );
    expect(getCustomerByEmail(db, 'nobody@example.com')).toBeNull();
  });

  it('listLeads 支持搜索与分页', () => {
    importLeads(db, [
      lead({ email: 'one@x.example.com', company_name: 'Alpha Ltd' }) as never,
      lead({ email: 'two@x.example.com', company_name: 'Beta Ltd' }) as never,
    ]);
    const all = listLeads(db, { page: 1, pageSize: 10 });
    expect(all.total).toBe(2);

    const searched = listLeads(db, { search: 'Alpha' });
    expect(searched.total).toBe(1);
    expect(searched.items[0]?.company_name).toBe('Alpha Ltd');
  });

  it('rescoreLead 更新线索与客户评分并写事件', () => {
    const result = importLeads(db, [lead() as never]);
    const created = result.leads[0];
    const leadId = created?.lead_id as number;

    const rescored = rescoreLead(db, leadId);
    expect(rescored.score).toBeGreaterThan(0);
    expect(rescored.customer_id).toBe(created?.customer_id);

    const customer = db
      .prepare('SELECT score FROM customers WHERE id = ?')
      .get(created?.customer_id) as { score: number };
    expect(customer.score).toBe(rescored.score);
  });

  it('rescoreLead 对不存在的线索抛 LEAD_NOT_FOUND', () => {
    try {
      rescoreLead(db, 999999);
      throw new Error('应当抛出异常');
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCode.LEAD_NOT_FOUND);
    }
  });

  it('getLeadById 返回线索或 null', () => {
    const result = importLeads(db, [lead() as never]);
    const leadId = result.leads[0]?.lead_id as number;
    expect(getLeadById(db, leadId)?.company_name).toBe('Acme Robotics GmbH');
    expect(getLeadById(db, 999999)).toBeNull();
  });
});
