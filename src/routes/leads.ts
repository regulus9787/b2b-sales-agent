/**
 * 线索路由
 */
import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate';
import { asyncRoute } from '../middleware/asyncRoute';
import { created, ok } from '../middleware/response';
import { leadImportBodySchema, leadQuerySchema } from '../schemas/lead';
import { getDb } from '../db/db';
import { importLeads, listLeads } from '../services/lead';
import { executeAndSummarize } from '../harness/workflow';
import { getCustomerDetail } from '../services/customer';

const router = Router();
const db = (): ReturnType<typeof getDb> => getDb();

/**
 * @openapi
 * /api/leads/import:
 *   post:
 *     tags: [Leads]
 *     summary: 批量导入线索（去重 + 评分）
 *     description: |
 *       按 `email + company_name` 归一化哈希去重。已存在的线索返回 `deduplicated: true`。
 *       设置 `run_workflow: true` 时，导入后会立即为前若干客户执行「评分 → 生成开发信」工作流。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [leads]
 *             properties:
 *               leads:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 200
 *                 items: { $ref: '#/components/schemas/LeadImportItem' }
 *               source: { type: string, example: webinar }
 *               score: { type: boolean, default: true }
 *               run_workflow: { type: boolean, default: false }
 *           examples:
 *             single:
 *               value:
 *                 leads:
 *                   - company_name: Beijing Quantum Robotics
 *                     contact_name: Liu Yang
 *                     email: liu.yang@quantum-robotics.example.com
 *                     industry: 工业机器人
 *                     country: CN
 *                     company_size: 100-500
 *                     notes: 展会收集，明确采购需求
 *                 source: webinar
 *     responses:
 *       201:
 *         description: 导入结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, enum: [true] }
 *                 data:
 *                   type: object
 *                   properties:
 *                     imported: { type: integer, example: 1 }
 *                     duplicated: { type: integer, example: 0 }
 *                     total: { type: integer, example: 1 }
 *                     workflow:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         run_id: { type: string }
 *                         status: { type: string, enum: [succeeded, failed] }
 *                         steps: { type: array, items: { $ref: '#/components/schemas/AgentStep' } }
 *                     customers:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/CustomerSummary' }
 *                 meta: { $ref: '#/components/schemas/Meta' }
 *       400:
 *         description: 校验失败（VALIDATION_ERROR）
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.post(
  '/leads/import',
  validate(leadImportBodySchema, 'body'),
  asyncRoute(async (req, res) => {
    const body = req.body as z.infer<typeof leadImportBodySchema>;
    const database = db();

    const result = importLeads(database, body.leads, {
      source: body.source ?? 'api',
      trigger: 'import_leads',
      requestId: res.locals.requestId,
    });

    let workflow: unknown = null;
    if (body.run_workflow && result.leads.length > 0) {
      const customerIds = [...new Set(result.leads.map((lead) => lead.customer_id))].slice(0, 5);
      const summaries = [];
      const steps: unknown[] = [];
      for (const customerId of customerIds) {
        // 逐个客户跑「评分 → 生成开发信」，避免单次请求过大
        const score = await executeAndSummarize(database, {
          workflow: 'full_cycle',
          customerId,
          sendEmail: true,
          trigger: 'lead_import',
        });
        summaries.push({
          customer_id: customerId,
          run_id: score.run_id,
          status: score.status,
          to_status: score.output?.customers[0]?.to_status ?? null,
          intent: score.output?.customers[0]?.intent ?? null,
        });
        steps.push(...score.steps);
      }
      workflow = { customers: summaries, steps };
    }

    const customers = result.leads
      .map((lead) => {
        try {
          return getCustomerDetail(database, lead.customer_id).customer;
        } catch {
          return null;
        }
      })
      .filter((customer): customer is NonNullable<typeof customer> => customer !== null);

    return created(res, {
      imported: result.imported,
      duplicated: result.duplicated,
      total: result.total,
      leads: result.leads,
      customers,
      workflow,
    });
  }),
);

/**
 * @openapi
 * /api/leads:
 *   get:
 *     tags: [Leads]
 *     summary: 线索列表（分页 / 搜索）
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: pageSize
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 20 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: 线索列表
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
router.get('/leads', validate(leadQuerySchema, 'query'), (req, res) => {
  const query = req.query as unknown as z.infer<typeof leadQuerySchema>;
  const result = listLeads(db(), {
    page: query.page,
    pageSize: query.pageSize,
    search: query.search,
  });
  return ok(res, {
    items: result.items,
    pagination: {
      page: result.page,
      pageSize: result.pageSize,
      total: result.total,
      totalPages: Math.ceil(result.total / result.pageSize),
    },
  });
});

export default router;
