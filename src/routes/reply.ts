/**
 * 回复与意图分类路由
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { asyncRoute } from '../middleware/asyncRoute';
import { ok } from '../middleware/response';
import { customerIdParamSchema } from '../schemas/common';
import { analyzeReplyBodySchema } from '../schemas/reply';
import { listCustomerReplies, receiveReply, simulateCustomerReply } from '../services/reply';
import { getDb } from '../db/db';
import { getCustomerSummary } from '../services/customer';

const router = Router();
const db = (): ReturnType<typeof getDb> => getDb();

/**
 * @openapi
 * /api/reply/analyze/{customerId}:
 *   post:
 *     tags: [Reply]
 *     summary: 分析客户回复并自动更新状态
 *     description: |
 *       接收回复文本（或用 `simulate: true` 生成模拟回复），通过 LLM 网关做意图分类
 *       （严格 JSON + Zod enum 校验），写入 replies 表并推进状态：
 *       `contacted → replied → interested | needs_info | rejected | neutral`。
 *
 *       分类失败时降级为 `neutral`（或规则兜底）并记录，不会中断链路。
 *     parameters:
 *       - in: path
 *         name: customerId
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               body:
 *                 type: string
 *                 description: 客户回复正文；不传且 simulate=true 时自动生成
 *                 example: 你好，我们对这个方案很感兴趣，下周二方便安排一次演示吗？
 *               intent:
 *                 type: string
 *                 enum: [interested, needs_info, rejected, neutral]
 *                 description: 指定模拟回复的意图（仅 simulate 时生效）
 *               simulate: { type: boolean, default: false }
 *               email_message_id: { type: integer, description: 关联的邮件 ID }
 *               run_id: { type: string }
 *               force: { type: boolean, default: false, description: 强制刷新状态 }
 *     responses:
 *       200:
 *         description: 分类与状态更新结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     customer_id: { type: integer }
 *                     reply_id: { type: integer }
 *                     reply_body: { type: string }
 *                     simulated: { type: boolean }
 *                     classification:
 *                       type: object
 *                       properties:
 *                         intent: { type: string, enum: [interested, needs_info, rejected, neutral] }
 *                         confidence: { type: number, example: 0.82 }
 *                         sentiment: { type: string, enum: [positive, neutral, negative] }
 *                         summary: { type: string }
 *                         suggested_action: { type: string }
 *                         needs_human: { type: boolean }
 *                     provider: { type: string }
 *                     model: { type: string }
 *                     prompt_tokens: { type: integer }
 *                     completion_tokens: { type: integer }
 *                     latency_ms: { type: integer }
 *                     cost_usd: { type: number }
 *                     mock: { type: boolean }
 *                     prompt_version: { type: string }
 *                     fallback: { type: boolean }
 *                     from_status: { type: string }
 *                     to_status: { type: string }
 *                     status_changed: { type: boolean }
 *                     status_change_error: { type: string, nullable: true }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 *       404:
 *         description: 客户不存在
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.post(
  '/reply/analyze/:customerId',
  validate(customerIdParamSchema, 'params'),
  validate(analyzeReplyBodySchema, 'body'),
  asyncRoute(async (req, res) => {
    const { customerId } = req.params as unknown as z.infer<typeof customerIdParamSchema>;
    const body = req.body as z.infer<typeof analyzeReplyBodySchema>;
    const database = db();

    let replyBody = body.body;
    let simulated = false;

    if (!replyBody || replyBody.trim() === '' || body.simulate) {
      const simulatedReply = simulateCustomerReply(database, {
        customerId,
        intent: body.intent,
      });
      replyBody = replyBody && replyBody.trim() !== '' ? replyBody : simulatedReply.body;
      simulated = true;
    }

    const result = await receiveReply(database, {
      customerId,
      body: replyBody,
      emailMessageId: body.email_message_id ?? null,
      runId: body.run_id ?? null,
      requestId: res.locals.requestId,
      simulated,
      force: body.force,
      trigger: simulated ? 'simulate_reply' : 'api',
    });

    return ok(res, {
      customer_id: result.reply.customer_id,
      reply_id: result.reply.id,
      reply_body: result.reply.body,
      simulated,
      classification: {
        intent: result.classification.intent,
        confidence: result.classification.confidence,
        sentiment: result.classification.sentiment,
        summary: result.classification.summary,
        suggested_action: result.classification.suggested_action,
        needs_human: result.classification.needs_human,
      },
      provider: result.provider,
      model: result.model,
      prompt_tokens: result.prompt_tokens,
      completion_tokens: result.completion_tokens,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
      mock: result.mock,
      prompt_version: result.prompt_version,
      fallback: result.fallback,
      from_status: result.from_status,
      to_status: result.to_status,
      status_changed: result.status_changed,
      status_change_error: result.status_change_error,
    });
  }),
);

/**
 * @openapi
 * /api/reply/customer/{customerId}:
 *   get:
 *     tags: [Reply]
 *     summary: 查询某客户的全部回复与分类结果
 *     parameters:
 *       - in: path
 *         name: customerId
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: 回复列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     customer: { $ref: '#/components/schemas/CustomerSummary' }
 *                     replies: { type: array, items: { $ref: '#/components/schemas/Reply' } }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 */
router.get('/reply/customer/:customerId', validate(customerIdParamSchema, 'params'), (req, res) => {
  const { customerId } = req.params as unknown as z.infer<typeof customerIdParamSchema>;
  const database = db();
  return ok(res, {
    customer: getCustomerSummary(database, customerId),
    replies: listCustomerReplies(database, customerId, 100),
  });
});

export default router;
