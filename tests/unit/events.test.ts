/**
 * 单元测试：事件写入（src/core/events.ts）—— append-only 语义
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/db/db';
import { seedDatabase } from '../../src/db/seed';
import {
  changeCustomerStatus,
  countCustomerEvents,
  listCustomerEvents,
  listStatusTimeline,
  recordEvent,
  verifyAppendOnly,
} from '../../src/core/events';
import { AppError, ErrorCode } from '../../src/core/errors';

let db: Database;
let customerId: number;

beforeEach(() => {
  db = openDatabase({ filename: ':memory:' });
  const seed = seedDatabase(db, { silent: true });
  customerId = seed.customerIds[0] as number;
});

afterEach(() => {
  db.close();
});

describe('core/events 事件表', () => {
  it('recordEvent 追加事件并返回 DTO', () => {
    const event = recordEvent(db, {
      customerId,
      eventType: 'note_added',
      trigger: 'test',
      payload: { hello: 'world' },
    });
    expect(event.id).toBeGreaterThan(0);
    expect(event.event_type).toBe('note_added');
    expect(event.payload).toEqual({ hello: 'world' });
    expect(event.actor).toBe('system');
  });

  it('changeCustomerStatus 合法跳转同时更新状态与事件', () => {
    // seed 第一个客户状态为 new
    const before = countCustomerEvents(db, customerId);
    const result = changeCustomerStatus({
      db,
      customerId,
      toStatus: 'enriched',
      trigger: 'test',
      payload: { reason: 'test' },
    });

    expect(result.fromStatus).toBe('new');
    expect(result.toStatus).toBe('enriched');
    expect(result.changed).toBe(true);
    expect(countCustomerEvents(db, customerId)).toBe(before + 1);

    const row = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
      status: string;
    };
    expect(row.status).toBe('enriched');
  });

  it('非法跳转抛 AppError 且不写入任何事件', () => {
    const before = countCustomerEvents(db, customerId);
    expect(() =>
      changeCustomerStatus({ db, customerId, toStatus: 'closed', trigger: 'test' }),
    ).toThrowError(AppError);

    try {
      changeCustomerStatus({ db, customerId, toStatus: 'closed', trigger: 'test' });
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
    }

    expect(countCustomerEvents(db, customerId)).toBe(before);
    const row = db.prepare('SELECT status FROM customers WHERE id = ?').get(customerId) as {
      status: string;
    };
    expect(row.status).toBe('new');
  });

  it('自环跳转只追加事件、不改变状态', () => {
    const before = countCustomerEvents(db, customerId);
    const result = changeCustomerStatus({ db, customerId, toStatus: 'new', trigger: 'idempotent' });
    expect(result.changed).toBe(false);
    expect(countCustomerEvents(db, customerId)).toBe(before + 1);
  });

  it('客户不存在时抛 CUSTOMER_NOT_FOUND', () => {
    try {
      changeCustomerStatus({ db, customerId: 999999, toStatus: 'enriched', trigger: 'test' });
      throw new Error('应当抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.CUSTOMER_NOT_FOUND);
    }
  });

  it('events 表是 append-only：UPDATE 与 DELETE 都被触发器拒绝', () => {
    const event = recordEvent(db, {
      customerId,
      eventType: 'status_changed',
      fromStatus: 'new',
      toStatus: 'new',
      trigger: 'test',
    });

    const verification = verifyAppendOnly(db, event.id);
    expect(verification.updateBlocked).toBe(true);
    expect(verification.deleteBlocked).toBe(true);

    // 内容保持不变
    const row = db.prepare('SELECT trigger FROM events WHERE id = ?').get(event.id) as {
      trigger: string;
    };
    expect(row.trigger).toBe('test');
  });

  it('listCustomerEvents / listStatusTimeline / countCustomerEvents 正常工作', () => {
    changeCustomerStatus({ db, customerId, toStatus: 'enriched', trigger: 'test' });
    changeCustomerStatus({ db, customerId, toStatus: 'email_drafted', trigger: 'test' });

    const events = listCustomerEvents(db, { customerId, limit: 100 });
    expect(events.length).toBe(countCustomerEvents(db, customerId));

    const timeline = listStatusTimeline(db, customerId);
    expect(timeline.length).toBeGreaterThanOrEqual(2);
    expect(timeline.every((item) => item.event_type === 'status_changed')).toBe(true);
  });
});
