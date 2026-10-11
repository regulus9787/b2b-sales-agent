/**
 * 单元测试：邮件服务（src/services/email.ts）
 * LLM 走 Mock 模式（确定性输出），无需真实密钥。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/db';
import { seedDatabase } from '../../src/db/seed';
import {
  generateEmail,
  getLatestOutboundEmail,
  listCustomerEmails,
} from '../../src/services/email';
import { importLeads } from '../../src/services/lead';
import { customerIdByStatus } from '../helpers/testDb';
import { AppError } from '../../src/core/errors';

let db: Database;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  seedDatabase(db, { silent: true });
});

afterEach(() => {
  db.close();
});

describe('email 服务', () => {
  it('为 new 客户生成邮件：状态推进 new → enriched → email_drafted → contacted', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const result = await generateEmail(db, { customerId, send: true });

    expect(result.email_id).toBeGreaterThan(0);
    expect(result.subject.length).toBeGreaterThan(5);
    expect(result.body.length).toBeGreaterThan(50);
    expect(result.status).toBe('sent');
    expect(result.from_status).toBe('new');
    expect(result.to_status).toBe('contacted');
    expect(result.status_changed).toBe(true);
    expect(result.prompt_version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(result.mock).toBe(true);
    expect(result.prompt_tokens).toBeGreaterThan(0);
    expect(result.completion_tokens).toBeGreaterThan(0);

    const customer = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
      status: string;
    };
    expect(customer.status).toBe('contacted');
  });

  it('send=false 时停在 email_drafted', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const result = await generateEmail(db, { customerId, send: false });
    expect(result.status).toBe('draft');
    expect(result.to_status).toBe('email_drafted');

    const customer = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
      status: string;
    };
    expect(customer.status).toBe('email_drafted');
  });

  it('每个状态变更都写入 events（含 email_generated / email_sent）', async () => {
    const customerId = customerIdByStatus(db, 'new');
    await generateEmail(db, { customerId, send: true });

    const events = db
      .prepare('SELECT event_type FROM events WHERE customer_id = ? ORDER BY id')
      .all(customerId) as { event_type: string }[];
    const types = events.map((event) => event.event_type);
    expect(types).toContain('email_generated');
    expect(types).toContain('email_sent');
    expect(types.filter((type) => type === 'status_changed').length).toBeGreaterThanOrEqual(3);
  });

  it('llm_calls 记录 run_id、operation 与 token', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const runId = 'email-run-1';
    await generateEmail(db, { customerId, send: true, runId });

    const row = db
      .prepare('SELECT run_id, operation, prompt_tokens FROM llm_calls ORDER BY id DESC LIMIT 1')
      .get() as { run_id: string; operation: string; prompt_tokens: number };
    expect(row.run_id).toBe(runId);
    expect(row.operation).toBe('generate_email');
    expect(row.prompt_tokens).toBeGreaterThan(0);
  });

  it('客户不存在抛 CUSTOMER_NOT_FOUND', async () => {
    await expect(generateEmail(db, { customerId: 987654, send: true })).rejects.toBeInstanceOf(
      AppError,
    );
    await expect(generateEmail(db, { customerId: 987654, send: true })).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('已是 contacted 的客户可重复生成邮件且不产生非法状态跳转', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const first = await generateEmail(db, { customerId, send: true });
    const second = await generateEmail(db, { customerId, send: true });

    expect(first.email_id).not.toBe(second.email_id);
    const customer = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
      status: string;
    };
    expect(customer.status).toBe('contacted');
  });

  it('listCustomerEmails / getLatestOutboundEmail 返回最新邮件', async () => {
    const customerId = customerIdByStatus(db, 'new');
    await generateEmail(db, { customerId, send: true });
    await generateEmail(db, { customerId, send: false });

    const emails = listCustomerEmails(db, customerId);
    expect(emails.length).toBe(2);

    const latest = getLatestOutboundEmail(db, customerId);
    expect(latest?.id).toBe(emails[0]?.id);
    expect(latest?.direction).toBe('outbound');
  });

  it('邮件内容包含个性化客户信息', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const result = await generateEmail(db, { customerId, send: true });
    const customer = db
      .prepare('SELECT company_name FROM customers WHERE id = ?')
      .get(customerId) as {
      company_name: string;
    };
    expect(result.body).toContain(customer.company_name);
  });

  it('导入的新客户也能直接生成邮件', async () => {
    const imported = importLeads(db, [
      {
        company_name: 'Fresh Leads Co',
        email: 'fresh@leads.example.com',
        industry: 'SaaS 软件',
        country: 'CN',
        company_size: '50-100',
      },
    ]);
    const customerId = imported.leads[0]?.customer_id as number;
    const result = await generateEmail(db, { customerId, send: true });
    expect(result.to_status).toBe('contacted');
  });
});
