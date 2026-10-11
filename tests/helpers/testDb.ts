/**
 * 测试辅助：临时数据库 + 应用实例 + 测试数据
 * 使用文件型临时库（而非 :memory:），以便 WAL 与事务行为与生产一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import { openDatabase, setDb } from '../../src/db/db';
import { seedDatabase } from '../../src/db/seed';
import createApp from '../../src/app';
import config from '../../src/config';

export interface TestContext {
  db: Database;
  app: Express;
  file: string;
  cleanup: () => void;
}

/**
 * 创建独立的临时数据库 + Express 应用（Swagger 关闭以加速）。
 *
 * 关键点：
 *  1. 应用的数据库单例（getDb）读取 config.databasePath，这里必须同步指向临时文件；
 *  2. 单例一旦建立会跨用例复用，因此每步都显式 setDb(db)，
 *     否则同一 worker 内后续用例的 HTTP 请求会写到已删除的旧临时库。
 */
export const createTestContext = (options: { seed?: boolean } = {}): TestContext => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sales-agent-test-'));
  const file = path.join(dir, 'test.db');

  (config as { databasePath: string }).databasePath = file;

  const db = openDatabase({ filename: file });
  setDb(db); // 让应用内的 getDb() 命中同一个连接

  if (options.seed !== false) {
    seedDatabase(db, { silent: true });
  }

  const app = createApp({ swagger: false, skipDbWarmup: true });

  return {
    db,
    app,
    file,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // 已关闭则忽略
      }
      // 清空单例，避免下一个用例复用已关闭的连接
      setDb(null);
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows 下可能因句柄未释放而失败，忽略
      }
    },
  };
};

export interface CustomerIdRow {
  id: number;
}

/** 取第一个客户 id */
export const firstCustomerId = (db: Database): number =>
  (db.prepare('SELECT id FROM customers ORDER BY id ASC LIMIT 1').get() as CustomerIdRow).id;

/** 取指定状态的第一个客户 id */
export const customerIdByStatus = (db: Database, status: string): number => {
  const row = db
    .prepare('SELECT id FROM customers WHERE status = ? ORDER BY id ASC LIMIT 1')
    .get(status) as CustomerIdRow | undefined;
  if (!row) throw new Error(`没有状态为 ${status} 的客户`);
  return row.id;
};

/** 构造一条可导入的线索 */
export const sampleLead = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  company_name: 'Test Robotics GmbH',
  contact_name: 'Test Contact',
  email: `test-${Date.now()}-${Math.floor(Math.random() * 100000)}@example.com`,
  phone: '+49-30-1234-5678',
  website: 'https://test-robotics.example.com',
  industry: '工业机器人',
  country: 'DE',
  company_size: '100-500',
  notes: '展会收集，有明确采购需求',
  ...overrides,
});

/** 事件数量 */
export const countEvents = (db: Database, customerId?: number): number =>
  customerId === undefined
    ? (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c
    : (
        db.prepare('SELECT COUNT(*) AS c FROM events WHERE customer_id = ?').get(customerId) as {
          c: number;
        }
      ).c;

/** 把客户状态直接重置为指定值（仅供测试准备数据，绕过状态机） */
export const forceCustomerStatus = (db: Database, customerId: number, status: string): number => {
  db.prepare('UPDATE customers SET status = ? WHERE id = ?').run(status, customerId);
  return customerId;
};
