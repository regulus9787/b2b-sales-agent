/**
 * 看板统计路由
 */
import { Router } from 'express';
import { ok } from '../middleware/response';
import { getDb } from '../db/db';
import { getDashboardStats } from '../services/customer';
import { getLlmCallStats } from '../services/llm-log';
import { listToolNames } from '../harness/runner';
import config from '../config';

const router = Router();

/**
 * @openapi
 * /api/dashboard/stats:
 *   get:
 *     tags: [Dashboard]
 *     summary: 看板统计（各状态客户数量、漏斗、LLM/Agent 指标）
 *     responses:
 *       200:
 *         description: 统计数据
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total_customers: { type: integer, example: 10 }
 *                     by_status:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           status: { type: string }
 *                           label: { type: string }
 *                           count: { type: integer }
 *                     total_leads: { type: integer }
 *                     total_emails: { type: integer }
 *                     total_replies: { type: integer }
 *                     replied_rate: { type: number, example: 30.0 }
 *                     interested_rate: { type: number, example: 10.0 }
 *                     avg_score: { type: number }
 *                     llm:
 *                       type: object
 *                       properties:
 *                         calls: { type: integer }
 *                         prompt_tokens: { type: integer }
 *                         completion_tokens: { type: integer }
 *                         total_tokens: { type: integer }
 *                         cost_usd: { type: number }
 *                         avg_latency_ms: { type: integer }
 *                         errors: { type: integer }
 *                         fallbacks: { type: integer }
 *                         mock_calls: { type: integer }
 *                     agent:
 *                       type: object
 *                       properties:
 *                         runs: { type: integer }
 *                         succeeded: { type: integer }
 *                         failed: { type: integer }
 *                         avg_duration_ms: { type: integer }
 *                     intents: { type: array, items: { type: object } }
 *                     funnel: { type: array, items: { type: object } }
 *                     recent_events: { type: array, items: { $ref: '#/components/schemas/Event' } }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 */
router.get('/dashboard/stats', (_req, res) => {
  const db = getDb();
  const stats = getDashboardStats(db);
  return ok(res, {
    ...stats,
    llm_mode: config.llm.mock ? 'mock' : 'live',
    llm_model: config.llm.mock ? 'mock' : config.llm.model,
    agent_tools: listToolNames(),
    llm_totals: getLlmCallStats(db),
  });
});

export default router;
