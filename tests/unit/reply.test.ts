/**
 * 单元测试：回复与意图分类（src/services/reply.ts）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/db';
import { seedDatabase } from '../../src/db/seed';
import {
  classifyReplyText,
  inferSimulatedIntent,
  listCustomerReplies,
  pickSimulatedIntent,
  receiveReply,
  simulateCustomerReply,
} from '../../src/services/reply';
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

describe('reply 服务 · 意图分类', () => {
  it('分类结果满足 Zod schema（intent/confidence/sentiment/summary/action/needs_human）', async () => {
    const outcome = await classifyReplyText({
      replyText: '我们对这个方案很感兴趣，能否安排一次演示？',
      companyName: 'Test Co',
      status: 'replied',
    });

    expect(['interested', 'needs_info', 'rejected', 'neutral']).toContain(
      outcome.classification.intent,
    );
    expect(outcome.classification.confidence).toBeGreaterThan(0);
    expect(outcome.classification.confidence).toBeLessThanOrEqual(1);
    expect(['positive', 'neutral', 'negative']).toContain(outcome.classification.sentiment);
    expect(outcome.classification.summary.length).toBeGreaterThan(0);
    expect(outcome.fallback).toBe(false);
    expect(outcome.model).toBe('mock');
  });

  it('四类意图分别被正确识别', async () => {
    const cases: [string, string][] = [
      ['我们对这个方案很感兴趣，下周二方便安排演示吗？', 'interested'],
      ['请发一份详细报价和技术规格文档给我', 'needs_info'],
      ['我们没有预算，已经有供应商了，请不要再联系', 'rejected'],
      ['收到，谢谢，我转给相关同事了', 'neutral'],
    ];
    for (const [text, expected] of cases) {
      const outcome = await classifyReplyText({
        replyText: text,
        companyName: 'Test Co',
        status: 'replied',
      });
      expect(outcome.classification.intent, `文本: ${text}`).toBe(expected);
    }
  });

  it('分类调用写入 llm_calls（operation=classify_intent）', async () => {
    await classifyReplyText(
      { replyText: '很感兴趣', companyName: 'Test Co', status: 'replied' },
      { db, runId: 'classify-run' },
    );
    const row = db
      .prepare("SELECT run_id, operation FROM llm_calls WHERE operation = 'classify_intent'")
      .get() as { run_id: string; operation: string };
    expect(row.run_id).toBe('classify-run');
  });
});

describe('reply 服务 · 接收回复与状态推进', () => {
  it('contacted 客户回复后经 replied 推进到意图状态', async () => {
    const customerId = customerIdByStatus(db, 'contacted');
    const result = await receiveReply(db, {
      customerId,
      body: '我们对这个方案很感兴趣，能否在下周二安排一次演示？',
    });

    expect(result.from_status).toBe('contacted');
    expect(result.to_status).toBe('interested');
    expect(result.status_changed).toBe(true);
    expect(result.status_change_error).toBeNull();

    const customer = db
      .prepare('SELECT status, last_replied_at FROM customers WHERE id = ?')
      .get(customerId) as { status: string; last_replied_at: string | null };
    expect(customer.status).toBe('interested');
    expect(customer.last_replied_at).not.toBeNull();
  });

  it('写 events：reply_received、reply_classified 与 status_changed', async () => {
    const customerId = customerIdByStatus(db, 'contacted');
    await receiveReply(db, { customerId, body: '请发一份报价单给我' });

    const events = db
      .prepare('SELECT event_type FROM events WHERE customer_id = ? ORDER BY id')
      .all(customerId) as { event_type: string }[];
    const types = events.map((event) => event.event_type);
    expect(types).toContain('reply_received');
    expect(types).toContain('reply_classified');
    expect(types).toContain('status_changed');
  });

  it('replies 表记录意图、置信度与 token', async () => {
    const customerId = customerIdByStatus(db, 'enriched');
    const result = await receiveReply(db, { customerId, body: '预算已经用完，不考虑了' });
    expect(result.reply.intent).toBe('rejected');
    expect(result.reply.confidence).toBeGreaterThan(0);
    expect(result.reply.classified).toBe(true);
    // enriched 状态不能直接跳到意图状态（会被推进到 replied，进而拒绝或降级）
    expect(['enriched', 'replied', 'rejected']).toContain(result.to_status);
    expect(result.prompt_tokens).toBeGreaterThan(0);
  });

  it('replied 状态的客户被正确推进到意图状态', async () => {
    const customerId = customerIdByStatus(db, 'replied');
    const result = await receiveReply(db, { customerId, body: '请发一份详细报价单和技术规格给我' });
    expect(result.reply.intent).toBe('needs_info');
    expect(result.reply.classified).toBe(true);
    expect(result.reply.from_status).toBe('replied');
    expect(result.reply.to_status).toBe('needs_info');
  });

  it('客户不存在抛 CUSTOMER_NOT_FOUND', async () => {
    await expect(receiveReply(db, { customerId: 123456, body: 'hi' })).rejects.toMatchObject({
      code: 'CUSTOMER_NOT_FOUND',
    });
  });

  it('已是 interested 的客户再收到中性回复：记录分类但不变更状态', async () => {
    const customerId = customerIdByStatus(db, 'interested');
    const result = await receiveReply(db, { customerId, body: '收到，谢谢' });
    expect(result.status_changed).toBe(false);
    expect(result.status_change_error).toContain('INVALID_STATUS_TRANSITION');
    expect(result.reply.intent).toBe('neutral');
  });

  it('force=true 时强制刷新状态', async () => {
    const customerId = customerIdByStatus(db, 'interested');
    const result = await receiveReply(db, {
      customerId,
      body: '抱歉，我们的预算已经用完了',
      force: true,
    });
    expect(result.status_changed).toBe(true);
    expect(result.to_status).toBe('rejected');
  });

  it('listCustomerReplies 返回全部回复', async () => {
    const customerId = customerIdByStatus(db, 'contacted');
    await receiveReply(db, { customerId, body: '请发一份报价单' });
    const replies = listCustomerReplies(db, customerId);
    expect(replies.length).toBe(1);
    expect(replies[0]?.customer_id).toBe(customerId);
  });
});

describe('reply 服务 · 模拟回复', () => {
  it('pickSimulatedIntent 是确定性的', () => {
    expect(pickSimulatedIntent(3, 0)).toBe(pickSimulatedIntent(3, 0));
    expect(['interested', 'needs_info', 'rejected', 'neutral']).toContain(
      pickSimulatedIntent(7, 1),
    );
  });

  it('inferSimulatedIntent 依据备注推断意图', () => {
    expect(inferSimulatedIntent('要求提供详细技术规格与合规文档', 1)).toBe('needs_info');
    expect(inferSimulatedIntent('预算不足，明确拒绝本轮合作', 2)).toBe('rejected');
    expect(inferSimulatedIntent('明确表达合作意向，等待会议安排', 3)).toBe('interested');
    expect(inferSimulatedIntent(null, 4)).toBe(pickSimulatedIntent(4, 0));
  });

  it('simulateCustomerReply 使用指定意图生成可被分类的回复', async () => {
    const customerId = customerIdByStatus(db, 'contacted');
    const simulated = simulateCustomerReply(db, { customerId, intent: 'interested' });
    expect(simulated.intent).toBe('interested');

    const outcome = await classifyReplyText({
      replyText: simulated.body,
      companyName: 'Test Co',
      status: 'contacted',
    });
    expect(outcome.classification.intent).toBe('interested');
  });

  it('simulateCustomerReply 对不存在的客户抛错', () => {
    expect(() => simulateCustomerReply(db, { customerId: 555555 })).toThrowError(AppError);
  });
});
