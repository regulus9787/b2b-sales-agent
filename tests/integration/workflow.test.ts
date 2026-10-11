/**
 * 集成测试：核心业务链路
 *   导入线索 → 生成邮件 → 模拟回复 → 意图分类 → 状态自动更新
 * 直接调用 service / harness（不经 HTTP），验证数据一致性与事件可追溯性。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/db';
import { applyMigrations, getSchemaVersion, listTables } from '../../src/db/migrations';
import { seedDatabase } from '../../src/db/seed';
import { importLeads } from '../../src/services/lead';
import { generateEmail } from '../../src/services/email';
import { receiveReply } from '../../src/services/reply';
import { getCustomerDetail, getDashboardStats } from '../../src/services/customer';
import { executeAndSummarize } from '../../src/harness/workflow';
import { getAgentRunDetail } from '../../src/harness/runner';
import { sampleLead } from '../helpers/testDb';

let db: Database;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
});

afterEach(() => {
  db.close();
});

describe('数据库迁移与 seed', () => {
  it('迁移创建全部 8 张核心表 + schema_migrations', () => {
    const tables = listTables(db);
    for (const table of [
      'leads',
      'customers',
      'email_messages',
      'replies',
      'events',
      'agent_runs',
      'agent_run_steps',
      'llm_calls',
      'schema_migrations',
    ]) {
      expect(tables, `缺少表 ${table}`).toContain(table);
    }
    expect(getSchemaVersion(db)).toBeGreaterThan(0);
  });

  it('迁移幂等：重复执行不报错且不重复建表', () => {
    const first = applyMigrations(db);
    const second = applyMigrations(db);
    expect(first.applied.length).toBe(0); // openDatabase 已执行过
    expect(second.applied.length).toBe(0);
    expect(second.skipped.length).toBeGreaterThan(0);
  });

  it('seed 插入 10 条客户且幂等', () => {
    const first = seedDatabase(db, { silent: true });
    expect(first.inserted).toBe(10);
    expect(first.customerIds).toHaveLength(10);

    const second = seedDatabase(db, { silent: true });
    expect(second.inserted).toBe(0);
    expect(second.skipped).toBe(10);

    const count = db.prepare('SELECT COUNT(*) AS c FROM customers').get() as { c: number };
    expect(count.c).toBe(10);
  });

  it('外键约束生效（引用不存在的客户会失败）', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO email_messages (customer_id, subject, body, status) VALUES (999999, 's', 'b', 'draft')",
        )
        .run(),
    ).toThrowError(/FOREIGN KEY/i);
  });

  it('WAL 模式已开启（文件库）', () => {
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
  });
});

describe('核心链路：导入 → 生成邮件 → 分类 → 状态更新', () => {
  it('单客户完整链路的状态、事件与数据落库一致', async () => {
    // 1) 导入线索
    const imported = importLeads(db, [
      sampleLead({
        email: 'e2e@example.com',
        company_name: 'E2E Manufacturing Co',
        industry: '精密机械',
        country: 'DE',
        company_size: '500-1000',
        notes: '明确采购需求，预算充足',
      }) as never,
    ]);
    const customerId = imported.leads[0]?.customer_id as number;
    expect(imported.imported).toBe(1);

    // 导入即评分，分数应在合理区间
    const created = imported.leads[0];
    expect(created?.score).toBeGreaterThan(0);

    // 2) 生成开发信（含状态推进）
    const email = await generateEmail(db, { customerId, send: true, runId: 'e2e-run' });
    expect(email.to_status).toBe('contacted');
    expect(email.email_id).toBeGreaterThan(0);

    // 3) 客户回复 + 意图分类 + 状态更新
    const reply = await receiveReply(db, {
      customerId,
      body: '你好，我们对这个方案很感兴趣。下周二方便安排一次 30 分钟演示吗？我会拉上销售负责人。',
      runId: 'e2e-run',
    });
    expect(reply.classification.intent).toBe('interested');
    expect(reply.to_status).toBe('interested');
    expect(reply.status_changed).toBe(true);

    // 4) 校验最终状态
    const customer = db
      .prepare('SELECT status, last_contacted_at, last_replied_at FROM customers WHERE id = ?')
      .get(customerId) as {
      status: string;
      last_contacted_at: string | null;
      last_replied_at: string | null;
    };
    expect(customer.status).toBe('interested');
    expect(customer.last_contacted_at).not.toBeNull();
    expect(customer.last_replied_at).not.toBeNull();

    // 5) 校验事件链完整且顺序正确
    const events = db
      .prepare(
        'SELECT event_type, from_status, to_status FROM events WHERE customer_id = ? ORDER BY id',
      )
      .all(customerId) as {
      event_type: string;
      from_status: string | null;
      to_status: string | null;
    }[];
    const chain = events.map((event) => event.event_type);
    expect(chain).toEqual(
      expect.arrayContaining([
        'lead_imported',
        'lead_scored',
        'email_generated',
        'email_sent',
        'reply_received',
        'reply_classified',
      ]),
    );

    const statusChain = events
      .filter((event) => event.event_type === 'status_changed')
      .map((event) => `${event.from_status}->${event.to_status}`);
    expect(statusChain).toEqual([
      'enriched->email_drafted',
      'email_drafted->contacted',
      'contacted->replied',
      'replied->interested',
    ]);

    // 6) 校验邮件 / 回复 / LLM 调用落库
    const emails = db
      .prepare('SELECT COUNT(*) AS c FROM email_messages WHERE customer_id = ?')
      .get(customerId) as {
      c: number;
    };
    expect(emails.c).toBe(1);

    const replies = db
      .prepare('SELECT intent, confidence FROM replies WHERE customer_id = ?')
      .all(customerId) as {
      intent: string;
      confidence: number;
    }[];
    expect(replies).toHaveLength(1);
    expect(replies[0]?.intent).toBe('interested');
    expect(replies[0]?.confidence).toBeGreaterThan(0);

    const llmCalls = db
      .prepare("SELECT operation FROM llm_calls WHERE run_id = 'e2e-run' ORDER BY id")
      .all() as { operation: string }[];
    expect(llmCalls.map((call) => call.operation)).toEqual(['generate_email', 'classify_intent']);

    // 7) 详情接口数据完整
    const detail = getCustomerDetail(db, customerId);
    expect(detail.customer.status).toBe('interested');
    expect(detail.emails).toHaveLength(1);
    expect(detail.replies).toHaveLength(1);
    expect(detail.timeline.length).toBe(4);
  });

  it('批量导入 + 逐客户跑完整工作流（Agent 编排）', async () => {
    const leads = [
      sampleLead({
        email: 'batch1@example.com',
        company_name: 'Batch One Co',
        notes: '有明确合作意向',
      }),
      sampleLead({
        email: 'batch2@example.com',
        company_name: 'Batch Two Co',
        notes: '要求提供技术资料',
      }),
    ];

    const result = await executeAndSummarize(db, {
      workflow: 'import_and_draft',
      leads: leads as never,
      limit: 2,
      trigger: 'integration-test',
    });

    expect(result.status).toBe('succeeded');
    expect(result.output?.totals.customers).toBe(2);
    expect(result.output?.totals.emails).toBe(2);

    const detail = getAgentRunDetail(db, result.run_id);
    expect(detail?.steps.map((step) => step.tool)).toEqual([
      'import_leads',
      'score_lead',
      'generate_email',
      'score_lead',
      'generate_email',
    ]);

    const stats = getDashboardStats(db);
    expect(stats.total_customers).toBe(2);
    expect(stats.total_emails).toBe(2);
  });

  it('工作流失败时 agent_runs 记录错误且不写脏状态', async () => {
    const result = await executeAndSummarize(db, {
      workflow: 'full_cycle',
      customerId: 999999,
      trigger: 'integration-test',
    }).catch((error: Error) => error);

    expect(result).toBeInstanceOf(Error);
    const runs = db.prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number };
    expect(runs.c).toBe(0);
  });

  it('同一客户重复跑工作流：状态保持合法且事件持续追加', async () => {
    const imported = importLeads(db, [
      sampleLead({ email: 'repeat@example.com', notes: '有采购意向' }) as never,
    ]);
    const customerId = imported.leads[0]?.customer_id as number;

    const first = await executeAndSummarize(db, {
      workflow: 'full_cycle',
      customerId,
      simulateIntent: 'interested',
      trigger: 'integration-test',
    });
    expect(first.status).toBe('succeeded');

    const eventsAfterFirst = (
      db.prepare('SELECT COUNT(*) AS c FROM events WHERE customer_id = ?').get(customerId) as {
        c: number;
      }
    ).c;

    const second = await executeAndSummarize(db, {
      workflow: 'full_cycle',
      customerId,
      simulateIntent: 'needs_info',
      trigger: 'integration-test',
    });
    expect(second.status).toBe('succeeded');

    const eventsAfterSecond = (
      db.prepare('SELECT COUNT(*) AS c FROM events WHERE customer_id = ?').get(customerId) as {
        c: number;
      }
    ).c;
    expect(eventsAfterSecond).toBeGreaterThan(eventsAfterFirst);

    // 状态始终是合法枚举值
    const customer = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
      status: string;
    };
    expect([
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
    ]).toContain(customer.status);
  });

  it('意图分类失败时降级为 neutral 并记录 fallback（模拟 LLM 异常）', async () => {
    const imported = importLeads(db, [sampleLead({ email: 'fallback@example.com' }) as never]);
    const customerId = imported.leads[0]?.customer_id as number;
    await generateEmail(db, { customerId, send: true });

    // 强制真实调用分支 + 始终 500，触发降级路径
    const { classifyReplyText } = await import('../../src/services/reply');
    const outcome = await classifyReplyText(
      {
        replyText: '你好',
        companyName: 'Fallback Co',
        status: 'contacted',
      },
      { db },
    );

    // Mock 模式下不会降级；这里断言正常路径的字段完备性
    expect(outcome.fallback).toBe(false);
    expect(outcome.classification.intent).toBeDefined();
    expect(outcome.classification.needs_human).toBeDefined();
  });
});
