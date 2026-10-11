/**
 * better-sqlite3 连接（AGENTS.md 第 3 节）
 * - WAL 模式，提升并发读性能
 * - foreign_keys=ON，外键约束生效
 * - 迁移幂等，可重复调用
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import config from '../config';
import { applyMigrations } from './migrations';

export type Db = Database.Database;

let instance: Db | null = null;

export interface OpenDbOptions {
  /** 覆盖数据库路径（测试用 :memory:） */
  filename?: string;
  /** 是否开启 WAL（内存库不支持 WAL） */
  wal?: boolean;
  /** 打开后是否自动执行迁移，默认 true */
  migrate?: boolean;
  verbose?: boolean;
}

export const openDatabase = (options: OpenDbOptions = {}): Db => {
  const filename = options.filename ?? config.databasePath;
  const useWal = options.wal ?? filename !== ':memory:';

  if (filename !== ':memory:') {
    const dir = path.dirname(filename);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(filename, options.verbose ? { verbose: console.log } : {});

  // 写前日志 + 外键约束 + 忙等待（避免 SQLITE_BUSY）
  if (useWal) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  if (options.migrate !== false) {
    applyMigrations(db);
  }

  return db;
};

/** 进程级单例（HTTP 服务使用；测试请直接使用 openDatabase(':memory:')） */
export const getDb = (): Db => {
  if (!instance) {
    instance = openDatabase();
  }
  return instance;
};

/**
 * 注入单例连接（仅用于测试：让应用与测试共享同一个临时数据库）。
 * 传入 null 时清空单例。
 */
export const setDb = (db: Db | null): void => {
  instance = db;
};

export const closeDb = (): void => {
  if (instance) {
    instance.close();
    instance = null;
  }
};

/** 事务包装：better-sqlite3 的 db.transaction 是同步的 */
export const transaction = <T extends (...args: never[]) => unknown>(fn: T): T => {
  const db = getDb();
  return db.transaction(fn) as unknown as T;
};

export const newId = (): string => crypto.randomUUID();

export const nowIso = (): string => new Date().toISOString();
