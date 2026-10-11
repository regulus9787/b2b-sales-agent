/**
 * npm run init-db        —— 迁移 + seed
 * npm run init-db --seed-only —— 只 seed
 * npm run reset-db       —— 删除数据库文件后重建（危险，仅开发用）
 *
 * 用法示例：
 *   npm run init-db
 *   npm run seed
 *   npm run reset-db
 */
import fs from 'node:fs';
import config from '../config';
import { openDatabase } from './db';
import { CURRENT_SCHEMA_VERSION, getSchemaVersion, listTables } from './migrations';
import { seedDatabase } from './seed';

const args = process.argv.slice(2);
const seedOnly = args.includes('--seed-only');
const reset = args.includes('--reset');

const removeDatabaseFiles = (filename: string): void => {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${filename}${suffix}`;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      // eslint-disable-next-line no-console
      console.log(`[init-db] 已删除 ${target}`);
    }
  }
};

const main = (): void => {
  const filename = config.databasePath;

  if (reset) {
    removeDatabaseFiles(filename);
  }

  // eslint-disable-next-line no-console
  console.log(`[init-db] 数据库路径: ${filename}`);

  if (seedOnly) {
    // 只 seed：仍然确保表结构存在（幂等迁移）
    const db = openDatabase({ filename });
    const result = seedDatabase(db);
    db.close();
    // eslint-disable-next-line no-console
    console.log(`[init-db] seed 完成：新增 ${result.inserted} 条`);
    return;
  }

  const db = openDatabase({ filename });

  const tables = listTables(db);
  // eslint-disable-next-line no-console
  console.log(`[init-db] schema 版本: ${getSchemaVersion(db)} / 目标 ${CURRENT_SCHEMA_VERSION}`);
  // eslint-disable-next-line no-console
  console.log(`[init-db] 表清单(${tables.length}): ${tables.join(', ')}`);

  const seedResult = seedDatabase(db);

  const counts = {
    leads: (db.prepare('SELECT COUNT(*) AS c FROM leads').get() as { c: number }).c,
    customers: (db.prepare('SELECT COUNT(*) AS c FROM customers').get() as { c: number }).c,
    events: (db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number }).c,
  };

  db.close();

  // eslint-disable-next-line no-console
  console.log(
    `[init-db] 完成 ✓  新增客户 ${seedResult.inserted} 条（跳过 ${seedResult.skipped}），` +
      `当前 leads=${counts.leads} customers=${counts.customers} events=${counts.events}`,
  );
};

main();
