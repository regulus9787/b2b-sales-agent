/**
 * 健康检查路由
 */
import { Router } from 'express';
import config from '../config';
import { getDb } from '../db/db';
import { getSchemaVersion } from '../db/migrations';
import { ok } from '../middleware/response';
import { listToolNames } from '../harness/runner';

const router = Router();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: 健康检查
 *     description: 返回服务状态、数据库 schema 版本、LLM 模式与已注册的 Agent 工具。
 *     responses:
 *       200:
 *         description: 服务正常
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     status: { type: string, example: ok }
 *                     uptime_s: { type: number, example: 12.34 }
 *                     version: { type: string, example: 1.0.0 }
 *                     env: { type: string, example: development }
 *                     database: { type: string, example: ok }
 *                     schema_version: { type: integer, example: 2 }
 *                     llm:
 *                       type: object
 *                       properties:
 *                         mode: { type: string, enum: [mock, live] }
 *                         provider: { type: string, example: mock }
 *                         model: { type: string, example: mock }
 *                         timeout_ms: { type: integer, example: 30000 }
 *                         max_retries: { type: integer, example: 3 }
 *                     agent_tools:
 *                       type: array
 *                       items: { type: string }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 */
router.get('/health', (_req, res) => {
  let database = 'ok';
  let schemaVersion = 0;
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    schemaVersion = getSchemaVersion(db);
  } catch (error) {
    database = `error: ${(error as Error).message}`;
  }

  return ok(res, {
    status: 'ok',
    uptime_s: Number(process.uptime().toFixed(2)),
    version: '1.0.0',
    env: config.env,
    timestamp: new Date().toISOString(),
    database,
    schema_version: schemaVersion,
    llm: {
      mode: config.llm.mock ? 'mock' : 'live',
      provider: config.llm.provider,
      model: config.llm.mock ? 'mock' : config.llm.model,
      base_url: config.llm.mock ? null : config.llm.baseUrl,
      timeout_ms: config.llm.timeoutMs,
      max_retries: config.llm.maxRetries,
    },
    agent_tools: listToolNames(),
  });
});

export default router;
