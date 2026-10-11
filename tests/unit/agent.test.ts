/**
 * 单元测试：Agent Runner 与工作流（src/harness/*）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/db';
import { seedDatabase } from '../../src/db/seed';
import {
  createToolRegistry,
  executeWorkflow,
  getAgentRunDetail,
  listAgentRuns,
  listToolNames,
} from '../../src/harness/runner';
import {
  executeAndSummarize,
  runClassifyOnly,
  runFullCycle,
  runWorkflow,
  WORKFLOWS,
} from '../../src/harness/workflow';
import { ruleBasedNextAction } from '../../src/harness/tools';
import { customerIdByStatus, sampleLead } from '../helpers/testDb';

let db: Database;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  seedDatabase(db, { silent: true });
});

afterEach(() => {
  db.close();
});

describe('harness · 工具注册表', () => {
  it('注册了 AGENTS.md 要求的 5 个工具', () => {
    const names = listToolNames();
    expect(names).toEqual([
      'import_leads',
      'score_lead',
      'generate_email',
      'classify_reply',
      'suggest_next_action',
    ]);
  });

  it('每个工具都有输入/输出 Zod schema', () => {
    const registry = createToolRegistry();
    for (const [name, tool] of registry) {
      expect(tool.inputSchema, `${name} 缺少 inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${name} 缺少 outputSchema`).toBeDefined();
      expect(typeof tool.handler).toBe('function');
      expect(tool.description.length).toBeGreaterThan(5);
    }
  });

  it('输入校验失败时步骤被记录为 failed 并抛 VALIDATION_ERROR', async () => {
    const result = await executeWorkflow(
      db,
      { workflow: 'test_validation' },
      async (_context, tools) => {
        await tools.call('score_lead', { customer_id: -1 });
        return null;
      },
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('VALIDATION_ERROR');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe('failed');
  });

  it('未注册工具直接抛错并记录失败步骤', async () => {
    const result = await executeWorkflow(
      db,
      { workflow: 'test_unknown' },
      async (_context, tools) => {
        await tools.call('not_a_tool', {});
        return null;
      },
    );
    expect(result.status).toBe('failed');
    expect(result.error).toContain('未注册的工具');
  });

  it('ruleBasedNextAction 覆盖状态并随分数提升优先级', () => {
    expect(ruleBasedNextAction('new', 50, 'unknown').priority).toBe('high');
    expect(ruleBasedNextAction('neutral', 90, 'neutral').priority).toBe('high');
    expect(ruleBasedNextAction('rejected', 10, 'rejected').priority).toBe('low');
    expect(ruleBasedNextAction('unknown_status', 50, 'x').action).toBe('跟进客户');
    expect(ruleBasedNextAction('interested', 80, 'interested').playbook.length).toBeGreaterThan(0);
  });
});

describe('harness · 完整工作流', () => {
  it('full_cycle：new 客户跑完 score → email → reply → classify → status', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const result = await runFullCycle(db, {
      customerId,
      simulateIntent: 'interested',
      sendEmail: true,
    });

    expect(result.status).toBe('succeeded');
    expect(result.customer_id).toBe(customerId);
    expect(result.steps.length).toBeGreaterThanOrEqual(4);
    expect(result.steps.every((step) => step.status === 'succeeded')).toBe(true);
    expect(result.steps.map((step) => step.tool)).toContain('generate_email');
    expect(result.steps.map((step) => step.tool)).toContain('classify_reply');
    expect(result.llm_calls_count).toBeGreaterThanOrEqual(2);
    expect(result.total_tokens).toBeGreaterThan(0);

    const customer = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
      status: string;
    };
    expect(customer.status).toBe('interested');
  });

  it('full_cycle 写入 agent_runs 与 agent_run_steps', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const result = await runFullCycle(db, { customerId, simulateIntent: 'needs_info' });

    const detail = getAgentRunDetail(db, result.run_id);
    expect(detail).not.toBeNull();
    expect(detail?.status).toBe('succeeded');
    expect(detail?.steps.length).toBe(result.steps.length);
    expect(detail?.steps[0]?.input).toBeTruthy();
    expect(detail?.steps[0]?.output).toBeTruthy();
    expect(detail?.llm_calls.length).toBeGreaterThan(0);
    expect(detail?.events.length).toBeGreaterThan(0);
    expect(detail?.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('四种模拟意图都会推进到对应状态', async () => {
    const intents = ['interested', 'needs_info', 'rejected', 'neutral'] as const;
    // seed 中状态分布固定，这里把前 4 个客户重置为 new，验证四条意图分支
    const targets = db.prepare('SELECT id FROM customers ORDER BY id LIMIT 4').all() as {
      id: number;
    }[];
    for (const row of targets) {
      db.prepare("UPDATE customers SET status = 'new' WHERE id = ?").run(row.id);
    }

    for (let index = 0; index < intents.length; index += 1) {
      const customerId = targets[index]?.id as number;
      const intent = intents[index] as (typeof intents)[number];
      const result = await runFullCycle(db, {
        customerId,
        simulateIntent: intent,
        sendEmail: true,
      });
      expect(result.status).toBe('succeeded');
      const customer = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
        status: string;
      };
      expect(customer.status, `意图 ${intent}`).toBe(intent);
    }
  });

  it('import_and_draft：导入线索并生成开发信', async () => {
    const result = await executeAndSummarize(db, {
      workflow: 'import_and_draft',
      leads: [
        sampleLead(),
        sampleLead({ email: 'second@example.com', company_name: 'Second Co' }),
      ] as never,
      limit: 2,
      sendEmail: true,
    });

    expect(result.status).toBe('succeeded');
    expect(result.output?.totals.customers).toBe(2);
    expect(result.output?.totals.emails).toBe(2);
    expect(result.steps.some((step) => step.tool === 'import_leads')).toBe(true);

    const customers = db.prepare('SELECT COUNT(*) AS c FROM customers').get() as { c: number };
    expect(customers.c).toBe(12);
  });

  it('classify_only：只跑分类链路', async () => {
    const customerId = customerIdByStatus(db, 'contacted');
    const result = await runClassifyOnly(db, { customerId, simulateIntent: 'interested' });
    expect(result.status).toBe('succeeded');
    expect(result.steps.map((step) => step.tool)).toEqual([
      'classify_reply',
      'suggest_next_action',
    ]);
  });

  it('runWorkflow 参数缺失时抛 VALIDATION_ERROR', async () => {
    await expect(runWorkflow(db, { workflow: 'full_cycle' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(runWorkflow(db, { workflow: 'import_and_draft' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(runWorkflow(db, { workflow: 'classify_only' })).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('客户不存在时 full_cycle 抛 CUSTOMER_NOT_FOUND', async () => {
    await expect(runFullCycle(db, { customerId: 987654 })).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('executeAndSummarize 生成人类可读的步骤摘要', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const result = await executeAndSummarize(db, {
      workflow: 'full_cycle',
      customerId,
      simulateIntent: 'interested',
      trigger: 'test',
    });

    expect(result.status).toBe('succeeded');
    const emailStep = result.steps.find((step) => step.tool === 'generate_email');
    expect(emailStep?.summary).toContain('已生成邮件');
    const classifyStep = result.steps.find((step) => step.tool === 'classify_reply');
    expect(classifyStep?.summary).toContain('意图');
    expect(result.output?.customers[0]?.next_action).toBeTruthy();
  });

  it('listAgentRuns 支持按客户与状态过滤', async () => {
    const customerId = customerIdByStatus(db, 'new');
    await runFullCycle(db, { customerId, simulateIntent: 'interested' });

    const all = listAgentRuns(db, {});
    expect(all.total).toBeGreaterThanOrEqual(1);

    const byCustomer = listAgentRuns(db, { customerId });
    expect(byCustomer.total).toBe(1);

    const byStatus = listAgentRuns(db, { status: 'succeeded' });
    expect(byStatus.total).toBeGreaterThanOrEqual(1);
  });

  it('WORKFLOWS 常量与文档一致', () => {
    expect([...WORKFLOWS]).toEqual(['full_cycle', 'import_and_draft', 'classify_only']);
  });

  it('失败的步骤会写入 agent_run_steps 且 run 状态为 failed', async () => {
    const result = await executeWorkflow(db, { workflow: 'failing' }, async () => {
      throw new Error('boom');
    });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('boom');

    const row = db
      .prepare('SELECT status, error FROM agent_runs WHERE run_id = ?')
      .get(result.run_id) as {
      status: string;
      error: string;
    };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('boom');
  });
});
