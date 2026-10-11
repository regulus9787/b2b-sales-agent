/**
 * 集成测试：完整 REST API（Supertest）
 * LLM 走 Mock 模式，验证统一响应信封、request_id、错误码与状态机。
 *
 * 每个测试用例使用全新的临时数据库（beforeEach），保证用例之间完全隔离。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { createTestContext, customerIdByStatus, sampleLead } from '../helpers/testDb';

let ctx: ReturnType<typeof createTestContext>;
let app: Express;
let db: Database;

beforeEach(() => {
  ctx = createTestContext();
  app = ctx.app;
  db = ctx.db;
});

afterEach(() => {
  ctx.cleanup();
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('GET /health', () => {
  it('返回服务状态、schema 版本与 LLM 模式', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.status).toBe('ok');
    expect(response.body.data.schema_version).toBeGreaterThan(0);
    expect(response.body.data.llm.mode).toBe('mock');
    expect(response.body.data.agent_tools).toHaveLength(5);
    expect(response.body.meta.request_id).toMatch(UUID_RE);
  });
});

describe('统一响应与错误处理', () => {
  it('每个响应都带 x-request-id 头与 meta.request_id', async () => {
    const response = await request(app).get('/health').expect(200);
    expect(response.headers['x-request-id']).toMatch(UUID_RE);
    expect(response.body.meta.request_id).toBe(response.headers['x-request-id']);
  });

  it('客户端传入的 x-request-id 会被透传', async () => {
    const custom = 'my-custom-request-id-123';
    const response = await request(app).get('/health').set('x-request-id', custom).expect(200);
    expect(response.body.meta.request_id).toBe(custom);
    expect(response.headers['x-request-id']).toBe(custom);
  });

  it('未知接口返回 404 + NOT_FOUND', async () => {
    const response = await request(app).get('/api/nope').expect(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('非法查询参数返回 400 + VALIDATION_ERROR（含字段级 details）', async () => {
    const response = await request(app).get('/api/customers?page=0&pageSize=999').expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(response.body.error.details)).toContain('page');
  });

  it('客户不存在返回 404 + CUSTOMER_NOT_FOUND', async () => {
    const response = await request(app).get('/api/customers/999999').expect(404);
    expect(response.body.error.code).toBe('CUSTOMER_NOT_FOUND');
  });

  it('非法路径参数返回 400 + VALIDATION_ERROR', async () => {
    const response = await request(app).get('/api/customers/abc').expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('GET /api/customers', () => {
  it('返回分页数据', async () => {
    const response = await request(app).get('/api/customers?page=1&pageSize=5').expect(200);
    expect(response.body.data.items).toHaveLength(5);
    expect(response.body.data.pagination).toMatchObject({
      page: 1,
      pageSize: 5,
      total: 10,
      totalPages: 2,
    });
  });

  it('支持状态过滤', async () => {
    const response = await request(app).get('/api/customers?status=interested').expect(200);
    expect(response.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(
      response.body.data.items.every((item: { status: string }) => item.status === 'interested'),
    ).toBe(true);
  });

  it('非法状态返回 400', async () => {
    const response = await request(app).get('/api/customers?status=nope').expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('支持搜索', async () => {
    const response = await request(app).get('/api/customers?search=Nova').expect(200);
    expect(response.body.data.items).toHaveLength(1);
  });

  it('status-machine 返回状态机定义', async () => {
    const response = await request(app).get('/api/customers/status-machine').expect(200);
    expect(response.body.data.statuses).toContain('interested');
    expect(response.body.data.transitions.new).toEqual(['enriched']);
  });
});

describe('GET /api/customers/:id', () => {
  it('返回客户详情结构', async () => {
    const customerId = customerIdByStatus(db, 'interested');
    const response = await request(app).get(`/api/customers/${customerId}`).expect(200);
    const data = response.body.data;
    expect(data.customer.id).toBe(customerId);
    expect(Array.isArray(data.emails)).toBe(true);
    expect(Array.isArray(data.replies)).toBe(true);
    expect(Array.isArray(data.timeline)).toBe(true);
    expect(Array.isArray(data.llm_calls)).toBe(true);
    expect(data.allowed_transitions).toBeDefined();
    expect(data.next_action).toBeTruthy();
  });
});

describe('POST /api/leads/import', () => {
  it('导入线索返回 201 与评分结果', async () => {
    const response = await request(app)
      .post('/api/leads/import')
      .send({
        leads: [sampleLead({ email: 'api-import@example.com' })],
        source: 'integration-test',
      })
      .expect(201);

    expect(response.body.data.imported).toBe(1);
    expect(response.body.data.leads[0].score).toBeGreaterThan(0);
    expect(response.body.data.customers).toHaveLength(1);
  });

  it('重复导入被去重', async () => {
    const payload = { leads: [sampleLead({ email: 'dedupe@example.com' })] };
    await request(app).post('/api/leads/import').send(payload).expect(201);
    const second = await request(app).post('/api/leads/import').send(payload).expect(201);
    expect(second.body.data.imported).toBe(0);
    expect(second.body.data.duplicated).toBe(1);
  });

  it('空数组返回 400 + VALIDATION_ERROR', async () => {
    const response = await request(app).post('/api/leads/import').send({ leads: [] }).expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('邮箱格式错误返回 400', async () => {
    const response = await request(app)
      .post('/api/leads/import')
      .send({ leads: [sampleLead({ email: 'bad-email' })] })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('run_workflow=true 时同时执行全链路', async () => {
    const response = await request(app)
      .post('/api/leads/import')
      .send({ leads: [sampleLead({ email: 'workflow-import@example.com' })], run_workflow: true })
      .expect(201);

    expect(response.body.data.workflow).not.toBeNull();
    expect(response.body.data.workflow.customers[0].status).toBe('succeeded');
    expect(response.body.data.workflow.steps.length).toBeGreaterThan(0);
  });
});

describe('POST /api/email/generate/:customerId', () => {
  it('生成邮件并推进状态到 contacted', async () => {
    const customerId = customerIdByStatus(db, 'new');
    const response = await request(app)
      .post(`/api/email/generate/${customerId}`)
      .send({ send: true })
      .expect(200);

    const data = response.body.data;
    expect(data.subject.length).toBeGreaterThan(5);
    expect(data.body.length).toBeGreaterThan(50);
    expect(data.to_status).toBe('contacted');
    expect(data.prompt_tokens).toBeGreaterThan(0);
    expect(data.prompt_version).toMatch(/^v/);
    expect(data.mock).toBe(true);
  });

  it('send=false 时停在 email_drafted', async () => {
    // 重新造一个 new 客户
    const importResponse = await request(app)
      .post('/api/leads/import')
      .send({
        leads: [sampleLead({ email: 'draft-only@example.com', company_name: 'Draft Only Co' })],
      })
      .expect(201);
    const customerId = importResponse.body.data.leads[0].customer_id;

    const response = await request(app)
      .post(`/api/email/generate/${customerId}`)
      .send({ send: false })
      .expect(200);
    expect(response.body.data.to_status).toBe('email_drafted');
  });

  it('客户不存在返回 404', async () => {
    const response = await request(app)
      .post('/api/email/generate/987654')
      .send({ send: true })
      .expect(404);
    expect(response.body.error.code).toBe('CUSTOMER_NOT_FOUND');
  });
});

describe('POST /api/reply/analyze/:customerId', () => {
  it('分析真实回复文本并更新状态', async () => {
    const customerId = customerIdByStatus(db, 'contacted');
    const response = await request(app)
      .post(`/api/reply/analyze/${customerId}`)
      .send({ body: '我们对这个方案很感兴趣，下周二方便安排一次演示吗？' })
      .expect(200);

    const data = response.body.data;
    expect(data.classification.intent).toBe('interested');
    expect(data.to_status).toBe('interested');
    expect(data.status_changed).toBe(true);
    expect(data.simulated).toBe(false);
    expect(data.classification.confidence).toBeGreaterThan(0);
  });

  it('simulate=true 自动生成模拟回复', async () => {
    const importResponse = await request(app)
      .post('/api/leads/import')
      .send({ leads: [sampleLead({ email: 'sim@example.com', company_name: 'Simulate Co' })] })
      .expect(201);
    const customerId = importResponse.body.data.leads[0].customer_id;
    await request(app).post(`/api/email/generate/${customerId}`).send({ send: true }).expect(200);

    const response = await request(app)
      .post(`/api/reply/analyze/${customerId}`)
      .send({ simulate: true, intent: 'needs_info' })
      .expect(200);

    expect(response.body.data.simulated).toBe(true);
    expect(response.body.data.reply_body.length).toBeGreaterThan(20);
    expect(response.body.data.classification.intent).toBe('needs_info');
  });

  it('回复内容为空且未开启 simulate 时返回 400', async () => {
    const customerId = customerIdByStatus(db, 'contacted');
    const response = await request(app)
      .post(`/api/reply/analyze/${customerId}`)
      .send({ body: '' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('客户不存在返回 404', async () => {
    const response = await request(app)
      .post('/api/reply/analyze/987654')
      .send({ body: 'hello there' })
      .expect(404);
    expect(response.body.error.code).toBe('CUSTOMER_NOT_FOUND');
  });
});

describe('POST /api/agent/run 与 GET /api/agent/runs/:runId', () => {
  it('full_cycle 工作流返回步骤与客户结果', async () => {
    const importResponse = await request(app)
      .post('/api/leads/import')
      .send({
        leads: [sampleLead({ email: 'agent-run@example.com', company_name: 'Agent Run Co' })],
      })
      .expect(201);
    const customerId = importResponse.body.data.leads[0].customer_id;

    const response = await request(app)
      .post('/api/agent/run')
      .send({ workflow: 'full_cycle', customer_id: customerId, simulate_intent: 'interested' })
      .expect(200);

    const data = response.body.data;
    expect(data.status).toBe('succeeded');
    expect(data.steps.length).toBeGreaterThanOrEqual(4);
    expect(data.steps[0].summary).toBeTruthy();
    expect(data.llm_calls_count).toBeGreaterThanOrEqual(2);
    expect(data.total_tokens).toBeGreaterThan(0);
    expect(data.output.customers[0].to_status).toBe('interested');
    expect(response.body.meta.workflow).toBe('full_cycle');

    // 查看执行详情
    const detail = await request(app).get(`/api/agent/runs/${data.run_id}`).expect(200);
    expect(detail.body.data.run_id).toBe(data.run_id);
    expect(detail.body.data.steps.length).toBe(data.steps.length);
    expect(detail.body.data.llm_calls.length).toBeGreaterThan(0);
    expect(detail.body.data.events.length).toBeGreaterThan(0);
  });

  it('缺少 customer_id 与 leads 返回 400', async () => {
    const response = await request(app)
      .post('/api/agent/run')
      .send({ workflow: 'full_cycle' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('未知工作流返回 400', async () => {
    const response = await request(app)
      .post('/api/agent/run')
      .send({ workflow: 'not_a_workflow', customer_id: 1 })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('runId 不存在返回 404 + AGENT_RUN_NOT_FOUND', async () => {
    const response = await request(app)
      .get('/api/agent/runs/00000000-0000-0000-0000-000000000000')
      .expect(404);
    expect(response.body.error.code).toBe('AGENT_RUN_NOT_FOUND');
  });

  it('GET /api/agent/tools 返回工具与工作流清单', async () => {
    const response = await request(app).get('/api/agent/tools').expect(200);
    expect(response.body.data.tool_names).toHaveLength(5);
    expect(response.body.data.workflows).toHaveLength(3);
  });

  it('GET /api/agent/runs 分页返回执行记录', async () => {
    const customerId = customerIdByStatus(db, 'new');
    await request(app)
      .post('/api/agent/run')
      .send({ workflow: 'full_cycle', customer_id: customerId, simulate_intent: 'interested' })
      .expect(200);

    const response = await request(app).get('/api/agent/runs?page=1&pageSize=5').expect(200);
    expect(response.body.data.pagination.total).toBeGreaterThanOrEqual(1);
    expect(response.body.data.items.length).toBeGreaterThanOrEqual(1);
  });
});

describe('GET /api/dashboard/stats', () => {
  it('返回看板统计全量字段', async () => {
    // 先制造一次完整执行，让 LLM/Agent 指标非零
    const customerId = customerIdByStatus(db, 'new');
    await request(app)
      .post('/api/agent/run')
      .send({ workflow: 'full_cycle', customer_id: customerId, simulate_intent: 'interested' })
      .expect(200);

    const response = await request(app).get('/api/dashboard/stats').expect(200);
    const data = response.body.data;
    expect(data.total_customers).toBeGreaterThanOrEqual(10);
    expect(data.by_status).toHaveLength(11);
    expect(data.funnel).toHaveLength(5);
    expect(data.llm.calls).toBeGreaterThan(0);
    expect(data.llm.total_tokens).toBeGreaterThan(0);
    expect(data.agent.runs).toBeGreaterThan(0);
    expect(data.llm_mode).toBe('mock');
    expect(Array.isArray(data.agent_tools)).toBe(true);
  });
});

describe('events append-only（HTTP 层验证）', () => {
  it('事件数量随状态变更增长且不可修改', async () => {
    const first = db
      .prepare("SELECT id FROM customers WHERE status = 'enriched' ORDER BY id LIMIT 1")
      .get() as { id: number } | undefined;
    expect(first).toBeDefined();
    const customerId = first?.id as number;

    const before = (
      db.prepare('SELECT COUNT(*) AS c FROM events WHERE customer_id = ?').get(customerId) as {
        c: number;
      }
    ).c;

    const response = await request(app)
      .post(`/api/email/generate/${customerId}`)
      .send({ send: true })
      .expect(200);
    expect(response.body.data.to_status).toBe('contacted');

    const after = (
      db.prepare('SELECT COUNT(*) AS c FROM events WHERE customer_id = ?').get(customerId) as {
        c: number;
      }
    ).c;
    expect(after).toBeGreaterThan(before);

    const firstEvent = db.prepare('SELECT id FROM events ORDER BY id LIMIT 1').get() as {
      id: number;
    };
    expect(() => db.prepare('DELETE FROM events WHERE id = ?').run(firstEvent.id)).toThrowError(
      /append-only/,
    );
    expect(() =>
      db.prepare("UPDATE events SET trigger = 'tampered' WHERE id = ?").run(firstEvent.id),
    ).toThrowError(/append-only/);
  });
});
