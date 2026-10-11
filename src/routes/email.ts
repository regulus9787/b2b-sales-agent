/**
 * 邮件路由
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { asyncRoute } from '../middleware/asyncRoute';
import { ok } from '../middleware/response';
import { customerIdParamSchema } from '../schemas/common';
import { generateEmailBodySchema } from '../schemas/email';
import { generateEmail, listCustomerEmails } from '../services/email';
import { getDb } from '../db/db';
import { getCustomerSummary } from '../services/customer';

const router = Router();
const db = (): ReturnType<typeof getDb> => getDb();

/**
 * @openapi
 * /api/email/generate/{customerId}:
 *   post:
 *     tags: [Email]
 *     summary: 为指定客户生成个性化开发信（并模拟发送）
 *     description: |
 *       调用 LLM 网关（services/llm.ts）生成开发信，落库 email_messages，
 *       并推进状态：`new → enriched → email_drafted →（send=true）contacted`。
 *       所有状态变更都会写入 events 表。
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
 *               sender_name: { type: string, example: Alex Chen }
 *               pain_point: { type: string, example: 海外渠道线索转化率低 }
 *               value_prop: { type: string }
 *               language: { type: string, default: 中文为主，保留英文专业术语 }
 *               send: { type: boolean, default: true, description: 是否模拟发送并推进到 contacted }
 *               run_id: { type: string, description: 关联的 Agent run }
 *     responses:
 *       200:
 *         description: 生成结果
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
 *                     email_id: { type: integer }
 *                     subject: { type: string }
 *                     body: { type: string }
 *                     status: { type: string, enum: [draft, sent] }
 *                     provider: { type: string }
 *                     model: { type: string }
 *                     prompt_tokens: { type: integer }
 *                     completion_tokens: { type: integer }
 *                     latency_ms: { type: integer }
 *                     cost_usd: { type: number }
 *                     mock: { type: boolean }
 *                     prompt_version: { type: string, example: v1.2.0 }
 *                     from_status: { type: string }
 *                     to_status: { type: string }
 *                     status_changed: { type: boolean }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 *       404:
 *         description: 客户不存在
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       409:
 *         description: 非法状态跳转（INVALID_STATUS_TRANSITION）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 *       502:
 *         description: LLM 错误（LLM_ERROR / LLM_INVALID_OUTPUT）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.post(
  '/email/generate/:customerId',
  validate(customerIdParamSchema, 'params'),
  validate(generateEmailBodySchema, 'body'),
  asyncRoute(async (req, res) => {
    const { customerId } = req.params as unknown as z.infer<typeof customerIdParamSchema>;
    const body = req.body as z.infer<typeof generateEmailBodySchema>;

    const result = await generateEmail(db(), {
      customerId,
      send: body.send,
      senderName: body.sender_name,
      painPoint: body.pain_point,
      valueProp: body.value_prop,
      language: body.language,
      runId: body.run_id ?? null,
      requestId: res.locals.requestId,
      trigger: 'api',
    });

    return ok(res, {
      customer_id: result.customer_id,
      email_id: result.email_id,
      subject: result.subject,
      body: result.body,
      status: result.status,
      provider: result.provider,
      model: result.model,
      prompt_tokens: result.prompt_tokens,
      completion_tokens: result.completion_tokens,
      latency_ms: result.latency_ms,
      cost_usd: result.cost_usd,
      mock: result.mock,
      prompt_version: result.prompt_version,
      from_status: result.from_status,
      to_status: result.to_status,
      status_changed: result.status_changed,
    });
  }),
);

/**
 * @openapi
 * /api/email/customer/{customerId}:
 *   get:
 *     tags: [Email]
 *     summary: 查询某客户的全部邮件记录
 *     parameters:
 *       - in: path
 *         name: customerId
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: 邮件列表
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
 *                     emails: { type: array, items: { $ref: '#/components/schemas/EmailMessage' } }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 */
router.get('/email/customer/:customerId', validate(customerIdParamSchema, 'params'), (req, res) => {
  const { customerId } = req.params as unknown as z.infer<typeof customerIdParamSchema>;
  const database = db();
  return ok(res, {
    customer: getCustomerSummary(database, customerId),
    emails: listCustomerEmails(database, customerId, 100),
  });
});

export default router;
