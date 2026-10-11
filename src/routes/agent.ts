/**
 * Agent 工作流路由
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { asyncRoute } from '../middleware/asyncRoute';
import { ok } from '../middleware/response';
import { agentRunBodySchema, agentRunListQuerySchema } from '../schemas/agent';
import { runIdParamSchema } from '../schemas/common';
import { getDb } from '../db/db';
import { agentRunNotFound } from '../core/errors';
import { buildPaginationMeta } from '../schemas/common';
import { executeAndSummarize } from '../harness/workflow';
import { getAgentRunDetail, listAgentRuns, listToolNames, TOOL_CATALOG } from '../harness/runner';
import { WORKFLOW_DESCRIPTIONS, WORKFLOWS } from '../harness/workflow';
import { listLlmCallsByRun } from '../services/llm-log';

const router = Router();
const db = (): ReturnType<typeof getDb> => getDb();

/**
 * @openapi
 * /api/agent/run:
 *   post:
 *     tags: [Agent]
 *     summary: 触发 Agent 工作流
 *     description: |
 *       - `full_cycle`：score_lead → generate_email → send → receive_reply → classify_reply → update_status
 *       - `import_and_draft`：import_leads → score_lead → generate_email
 *       - `classify_only`：receive_reply → classify_reply → update_status
 *
 *       执行结果写入 agent_runs 与 agent_run_steps，可用 `GET /api/agent/runs/{runId}` 查看每一步。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               workflow:
 *                 type: string
 *                 enum: [full_cycle, import_and_draft, classify_only]
 *                 default: full_cycle
 *               customer_id: { type: integer, example: 1 }
 *               leads:
 *                 type: array
 *                 items: { $ref: '#/components/schemas/LeadImportItem' }
 *               simulate_intent:
 *                 type: string
 *                 enum: [interested, needs_info, rejected, neutral]
 *               send_email: { type: boolean, default: true }
 *               limit: { type: integer, default: 1, maximum: 50 }
 *               trigger: { type: string, default: api }
 *           examples:
 *             fullCycle:
 *               value: { workflow: full_cycle, customer_id: 1, simulate_intent: interested }
 *     responses:
 *       200:
 *         description: 工作流执行结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     run_id: { type: string, format: uuid }
 *                     workflow: { type: string }
 *                     status: { type: string, enum: [succeeded, failed] }
 *                     customer_id: { type: integer, nullable: true }
 *                     error: { type: string, nullable: true }
 *                     duration_ms: { type: integer }
 *                     llm_calls_count: { type: integer }
 *                     total_tokens: { type: integer }
 *                     total_cost_usd: { type: number }
 *                     steps:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           step_index: { type: integer }
 *                           tool: { type: string }
 *                           status: { type: string }
 *                           duration_ms: { type: integer }
 *                           summary: { type: string }
 *                     output:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         customers:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               customer_id: { type: integer }
 *                               intent: { type: string, nullable: true }
 *                               from_status: { type: string }
 *                               to_status: { type: string }
 *                               next_action: { type: string, nullable: true }
 *                         totals: { type: object }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 *       400:
 *         description: 参数校验失败
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       404:
 *         description: 客户不存在
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.post(
  '/agent/run',
  validate(agentRunBodySchema, 'body'),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof agentRunBodySchema>;
    const database = db();

    const result = await executeAndSummarize(database, {
      workflow: body.workflow,
      customerId: body.customer_id,
      leads: body.leads as never,
      simulateIntent: body.simulate_intent,
      sendEmail: body.send_email,
      limit: body.limit,
      trigger: body.trigger,
    });

    return ok(res, result, { workflow: result.workflow });
  }),
);

/**
 * @openapi
 * /api/agent/tools:
 *   get:
 *     tags: [Agent]
 *     summary: 已注册的 Agent 工具与可用工作流
 *     responses:
 *       200:
 *         description: 工具与工作流清单
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     tools:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           description: { type: string }
 *                     tool_names: { type: array, items: { type: string } }
 *                     workflows:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name: { type: string }
 *                           description: { type: string }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 */
router.get('/agent/tools', (_req, res) =>
  ok(res, {
    tools: TOOL_CATALOG,
    tool_names: listToolNames(),
    workflows: WORKFLOWS.map((name) => ({ name, description: WORKFLOW_DESCRIPTIONS[name] })),
  }),
);

/**
 * @openapi
 * /api/agent/runs:
 *   get:
 *     tags: [Agent]
 *     summary: Agent 执行记录列表
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: customer_id
 *         schema: { type: integer }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [running, succeeded, failed] }
 *     responses:
 *       200:
 *         description: 执行记录
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items: { type: array, items: { type: object } }
 *                     pagination: { $ref: '#/components/schemas/Pagination' }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 */
router.get('/agent/runs', validate(agentRunListQuerySchema, 'query'), (req, res) => {
  const query = req.query as unknown as z.infer<typeof agentRunListQuerySchema>;
  const result = listAgentRuns(db(), {
    page: query.page,
    pageSize: query.pageSize,
    customerId: query.customer_id,
    status: query.status,
  });
  return ok(res, {
    items: result.items.map((run) => ({
      run_id: run.run_id,
      workflow: run.workflow,
      status: run.status,
      trigger: run.trigger,
      customer_id: run.customer_id,
      steps_count: run.steps_count,
      llm_calls_count: run.llm_calls_count,
      total_tokens: run.total_tokens,
      total_cost_usd: run.total_cost_usd,
      duration_ms: run.duration_ms,
      started_at: run.started_at,
      finished_at: run.finished_at,
      error: run.error,
    })),
    pagination: buildPaginationMeta(result.page, result.pageSize, result.total),
  });
});

/**
 * @openapi
 * /api/agent/runs/{runId}:
 *   get:
 *     tags: [Agent]
 *     summary: Agent 执行详情（每一步的输入/输出 + LLM 调用明细 + 事件）
 *     parameters:
 *       - in: path
 *         name: runId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: 执行详情
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     run_id: { type: string }
 *                     workflow: { type: string }
 *                     status: { type: string }
 *                     input: { type: object, nullable: true }
 *                     output: { type: object, nullable: true }
 *                     steps: { type: array, items: { $ref: '#/components/schemas/AgentStep' } }
 *                     llm_calls: { type: array, items: { $ref: '#/components/schemas/LlmCall' } }
 *                     events: { type: array, items: { $ref: '#/components/schemas/Event' } }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 *       404:
 *         description: 执行记录不存在（AGENT_RUN_NOT_FOUND）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/agent/runs/:runId', validate(runIdParamSchema, 'params'), (req, res) => {
  const { runId } = req.params as unknown as z.infer<typeof runIdParamSchema>;
  const database = db();
  const detail = getAgentRunDetail(database, runId);
  if (!detail) {
    throw agentRunNotFound(runId);
  }
  return ok(res, { ...detail, llm_calls: listLlmCallsByRun(database, runId) });
});

export default router;
