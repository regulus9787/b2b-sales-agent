/**
 * 客户路由（薄层：只做校验 + 调用 service + 统一响应）
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { ok } from '../middleware/response';
import { customerQuerySchema } from '../schemas/customer';
import { idParamSchema } from '../schemas/common';
import { getCustomerDetail, listCustomers } from '../services/customer';
import { getDb } from '../db/db';
import { describeStatusMachine } from '../core/status';

const router = Router();
const db = (): ReturnType<typeof getDb> => getDb();

/**
 * @openapi
 * /api/customers:
 *   get:
 *     tags: [Customers]
 *     summary: 客户列表（分页 / 状态过滤 / 搜索）
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: status
 *         schema: { $ref: '#/components/schemas/CustomerStatus' }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: 模糊匹配公司名 / 邮箱 / 联系人 / 行业
 *       - in: query
 *         name: minScore
 *         schema: { type: integer, minimum: 0, maximum: 100 }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [created_at, updated_at, score, company_name], default: created_at }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [asc, desc], default: desc }
 *     responses:
 *       200:
 *         description: 客户列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/CustomerSummary' }
 *                     pagination: { $ref: '#/components/schemas/Pagination' }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 *       400:
 *         description: 参数校验失败
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/customers', validate(customerQuerySchema, 'query'), (req, res) => {
  const query = req.query as unknown as z.infer<typeof customerQuerySchema>;
  const result = listCustomers(db(), {
    page: query.page,
    pageSize: query.pageSize,
    status: query.status,
    search: query.search,
    minScore: query.minScore,
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  });
  return ok(res, result);
});

/**
 * @openapi
 * /api/customers/status-machine:
 *   get:
 *     tags: [Customers]
 *     summary: 获取客户状态机定义（状态、合法跳转、终态、中文标签）
 *     responses:
 *       200:
 *         description: 状态机
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     statuses: { type: array, items: { type: string } }
 *                     transitions: { type: object, additionalProperties: { type: array, items: { type: string } } }
 *                     terminal: { type: array, items: { type: string } }
 *                     labels: { type: object, additionalProperties: { type: string } }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 */
router.get('/customers/status-machine', (_req, res) => ok(res, describeStatusMachine()));

/**
 * @openapi
 * /api/customers/{id}:
 *   get:
 *     tags: [Customers]
 *     summary: 客户详情（含邮件、回复、状态时间线、LLM 调用与允许的下一步状态）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer, minimum: 1 }
 *     responses:
 *       200:
 *         description: 客户详情
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
 *                     replies: { type: array, items: { $ref: '#/components/schemas/Reply' } }
 *                     timeline: { type: array, items: { $ref: '#/components/schemas/Event' } }
 *                     events: { type: array, items: { $ref: '#/components/schemas/Event' } }
 *                     llm_calls: { type: array, items: { $ref: '#/components/schemas/LlmCall' } }
 *                     next_action: { type: object, nullable: true }
 *                     allowed_transitions: { type: array, items: { type: string } }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 *       404:
 *         description: 客户不存在（CUSTOMER_NOT_FOUND）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get('/customers/:id', validate(idParamSchema, 'params'), (req, res) => {
  const { id } = req.params as unknown as z.infer<typeof idParamSchema>;
  return ok(res, getCustomerDetail(db(), id));
});

export default router;
