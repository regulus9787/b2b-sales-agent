/**
 * 事件（append-only）写入 —— AGENTS.md 第 4 / 7 节
 *
 * 规则：
 *  1. 每次客户状态变更都必须写 events 表；
 *  2. events 只允许 INSERT（迁移中已用触发器拦截 UPDATE/DELETE）；
 *  3. 状态变更与事件写入必须在同一个事务内完成。
 */
import type { Database } from 'better-sqlite3';
import { customerNotFound } from './errors';
import { assertTransition, isSelfTransition, type CustomerStatus } from './status';
import type { EventDto, EventRow } from './models';
import { toEventDto } from './models';
import { nowIso } from '../db/db';
import { customerStatusSchema } from './status';

export const EVENT_TYPES = [
  'lead_imported',
  'lead_scored',
  'status_changed',
  'email_generated',
  'email_sent',
  'reply_received',
  'reply_classified',
  'agent_run_started',
  'agent_run_finished',
  'note_added',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface RecordEventInput {
  customerId: number;
  eventType: EventType;
  fromStatus?: CustomerStatus | null;
  toStatus?: CustomerStatus | null;
  trigger: string;
  runId?: string | null;
  actor?: string;
  payload?: unknown;
  requestId?: string | null;
  /** 自定义时间（测试用），默认 now */
  createdAt?: string;
}

/** 追加一条事件（只 INSERT，永不 UPDATE） */
export const recordEvent = (db: Database, input: RecordEventInput): EventDto => {
  const payload = input.payload === undefined ? null : JSON.stringify(input.payload);
  const info = db
    .prepare(
      `INSERT INTO events (customer_id, event_type, from_status, to_status, trigger, run_id, actor, payload, request_id, created_at)
       VALUES (@customer_id, @event_type, @from_status, @to_status, @trigger, @run_id, @actor, @payload, @request_id, @created_at)`,
    )
    .run({
      customer_id: input.customerId,
      event_type: input.eventType,
      from_status: input.fromStatus ?? null,
      to_status: input.toStatus ?? null,
      trigger: input.trigger,
      run_id: input.runId ?? null,
      actor: input.actor ?? 'system',
      payload,
      request_id: input.requestId ?? null,
      created_at: input.createdAt ?? nowIso(),
    });

  const id = Number(info.lastInsertRowid);
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow;
  return toEventDto(row);
};

export interface ChangeStatusInput {
  db: Database;
  customerId: number;
  toStatus: CustomerStatus;
  trigger: string;
  runId?: string | null;
  actor?: string;
  payload?: unknown;
  requestId?: string | null;
  /** 明确指定来源状态（工作流里已知），否则从数据库读取 */
  fromStatus?: CustomerStatus;
  /** 允许自环（幂等），默认 true */
  allowSelfTransition?: boolean;
}

export interface ChangeStatusResult {
  customerId: number;
  fromStatus: CustomerStatus;
  toStatus: CustomerStatus;
  changed: boolean;
  event: EventDto;
}

/**
 * 校验状态机 → 更新 customers.status → 写 events（同一事务）。
 * 非法跳转抛 AppError(INVALID_STATUS_TRANSITION) → HTTP 409。
 */
export const changeCustomerStatus = (input: ChangeStatusInput): ChangeStatusResult => {
  const { db, customerId, toStatus, trigger } = input;
  const target = customerStatusSchema.parse(toStatus);

  const row = db.prepare('SELECT id, status FROM customers WHERE id = ?').get(customerId) as
    { id: number; status: CustomerStatus } | undefined;

  // 允许调用方直接给出 from（工作流中已知），但必须与数据库一致
  let from = input.fromStatus;
  if (!row) {
    if (from === undefined) throw customerNotFound(customerId);
    // 行不存在时仍以 from 继续，后续 UPDATE 会命中 0 行
  } else {
    from = row.status;
  }
  const fromStatus = from as CustomerStatus;

  assertTransition(fromStatus, target);

  const selfTransition = isSelfTransition(fromStatus, target);
  if (selfTransition && input.allowSelfTransition === false) {
    throw new Error(`状态未发生变化: ${fromStatus}`);
  }

  const now = nowIso();
  const tx = db.transaction(() => {
    if (!selfTransition) {
      const updated = db
        .prepare('UPDATE customers SET status = @status, updated_at = @now WHERE id = @id')
        .run({ status: target, now, id: customerId });
      if (updated.changes === 0) {
        throw customerNotFound(customerId);
      }
    } else {
      db.prepare('UPDATE customers SET updated_at = @now WHERE id = @id').run({
        now,
        id: customerId,
      });
    }

    return recordEvent(db, {
      customerId,
      eventType: 'status_changed',
      fromStatus,
      toStatus: target,
      trigger,
      runId: input.runId ?? null,
      actor: input.actor ?? 'system',
      payload: input.payload,
      requestId: input.requestId ?? null,
      createdAt: now,
    });
  });

  const event = tx();

  return {
    customerId,
    fromStatus,
    toStatus: target,
    changed: !selfTransition,
    event,
  };
};

export interface ListEventsOptions {
  customerId: number;
  limit?: number;
  offset?: number;
}

export const listCustomerEvents = (db: Database, options: ListEventsOptions): EventDto[] => {
  const limit = options.limit ?? 100;
  const offset = options.offset ?? 0;
  const rows = db
    .prepare('SELECT * FROM events WHERE customer_id = ? ORDER BY id ASC LIMIT ? OFFSET ?')
    .all(options.customerId, limit, offset) as EventRow[];
  return rows.map(toEventDto);
};

export const countCustomerEvents = (db: Database, customerId: number): number =>
  (
    db.prepare('SELECT COUNT(*) AS c FROM events WHERE customer_id = ?').get(customerId) as {
      c: number;
    }
  ).c;

/** 时间线：状态变更事件（前端详情页使用） */
export const listStatusTimeline = (db: Database, customerId: number): EventDto[] => {
  const rows = db
    .prepare(
      `SELECT * FROM events WHERE customer_id = ? AND event_type = 'status_changed' ORDER BY id ASC`,
    )
    .all(customerId) as EventRow[];
  return rows.map(toEventDto);
};

/**
 * 证明 events 的 append-only 语义：任何 UPDATE/DELETE 都会被触发器拒绝。
 * 返回 true 表示「确实被拒绝」。
 */
export const verifyAppendOnly = (
  db: Database,
  eventId: number,
): { updateBlocked: boolean; deleteBlocked: boolean } => {
  let updateBlocked = false;
  let deleteBlocked = false;
  try {
    db.prepare("UPDATE events SET trigger = 'tampered' WHERE id = ?").run(eventId);
  } catch {
    updateBlocked = true;
  }
  try {
    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
  } catch {
    deleteBlocked = true;
  }
  return { updateBlocked, deleteBlocked };
};

export default recordEvent;
