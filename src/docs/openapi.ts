/**
 * OpenAPI / Swagger 文档（AGENTS.md 第 11 节：Swagger UI 挂在 /docs）
 * 使用 swagger-jsdoc 读取路由文件中的 JSDoc 注释生成文档。
 * 也可通过 npm run openapi 导出 docs/openapi.json。
 */
import path from 'node:path';
import swaggerJsdoc, { type Options } from 'swagger-jsdoc';
import { CUSTOMER_STATUSES, STATUS_LABELS } from '../core/status';
import { ERROR_HTTP_STATUS } from '../core/errors';
import { TOOL_CATALOG } from '../harness/runner';
import { WORKFLOW_DESCRIPTIONS, WORKFLOWS } from '../harness/workflow';

const routeGlob = path.resolve(__dirname, '../routes/*.ts').replace(/\\/g, '/');
const routeGlobJs = path.resolve(__dirname, '../routes/*.js').replace(/\\/g, '/');

export const openapiOptions: Options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'B2B Sales Agent API',
      version: '1.0.0',
      description: `
端到端 B2B 销售 Agent：线索导入 → LLM 个性化开发信 → 客户状态管理 → 模拟回复 → LLM 意图分类 → 自动更新状态。

## 统一响应格式
- 成功：\`{ "success": true, "data": {...}, "meta": { "request_id": "uuid" } }\`
- 失败：\`{ "success": false, "error": { "code": "...", "message": "..." }, "meta": { "request_id": "uuid" } }\`

## 错误码
${Object.entries(ERROR_HTTP_STATUS)
  .map(([code, status]) => `- \`${code}\` → HTTP ${status}`)
  .join('\n')}

## 客户状态机
\`new → enriched → email_drafted → contacted → replied\`；
\`replied → interested | needs_info | rejected | neutral\`；
\`interested → meeting_booked → closed\`。
非法跳转返回 HTTP 409 + \`INVALID_STATUS_TRANSITION\`。

## Agent 工具
${TOOL_CATALOG.map((tool) => `- \`${tool.name}\`：${tool.description}`).join('\n')}

## 工作流
${WORKFLOWS.map((name) => `- \`${name}\`：${WORKFLOW_DESCRIPTIONS[name]}`).join('\n')}

> LLM_API_KEY 为空时自动进入 Mock 模式，无需任何密钥即可跑通全流程。
      `.trim(),
    },
    servers: [
      { url: 'http://localhost:3000', description: '本地开发' },
      { url: '/', description: '当前主机（Docker / 反向代理）' },
    ],
    tags: [
      { name: 'Health', description: '健康检查' },
      { name: 'Customers', description: '客户查询与详情' },
      { name: 'Leads', description: '线索导入' },
      { name: 'Email', description: '开发信生成' },
      { name: 'Reply', description: '客户回复与意图分类' },
      { name: 'Agent', description: 'Agent 工作流' },
      { name: 'Dashboard', description: '看板统计' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: '预留：如需鉴权可在此配置（当前版本开放访问）',
        },
      },
      schemas: {
        Meta: {
          type: 'object',
          properties: { request_id: { type: 'string', format: 'uuid' } },
          required: ['request_id'],
        },
        Error: {
          type: 'object',
          properties: {
            code: { type: 'string', enum: Object.keys(ERROR_HTTP_STATUS) },
            message: { type: 'string' },
            details: { type: 'object', nullable: true },
          },
          required: ['code', 'message'],
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            success: { type: 'boolean', enum: [false] },
            error: { $ref: '#/components/schemas/Error' },
            meta: { $ref: '#/components/schemas/Meta' },
          },
          required: ['success', 'error', 'meta'],
        },
        Pagination: {
          type: 'object',
          properties: {
            page: { type: 'integer', example: 1 },
            pageSize: { type: 'integer', example: 20 },
            total: { type: 'integer', example: 42 },
            totalPages: { type: 'integer', example: 3 },
          },
        },
        CustomerStatus: {
          type: 'string',
          enum: [...CUSTOMER_STATUSES],
          description: CUSTOMER_STATUSES.map(
            (status) => `${status}（${STATUS_LABELS[status]}）`,
          ).join('，'),
        },
        Customer: {
          type: 'object',
          properties: {
            id: { type: 'integer', example: 1 },
            company_name: { type: 'string', example: 'Shenzhen Nova Electronics Co., Ltd.' },
            contact_name: { type: 'string', nullable: true, example: 'Kevin Zhang' },
            email: {
              type: 'string',
              format: 'email',
              example: 'kevin.zhang@nova-electronics.example.com',
            },
            phone: { type: 'string', nullable: true },
            website: { type: 'string', nullable: true },
            industry: { type: 'string', nullable: true, example: '消费电子制造' },
            country: { type: 'string', nullable: true, example: 'CN' },
            company_size: { type: 'string', nullable: true, example: '500-1000' },
            status: { $ref: '#/components/schemas/CustomerStatus' },
            score: { type: 'integer', example: 82 },
            source: { type: 'string', example: 'seed' },
            notes: { type: 'string', nullable: true },
            last_contacted_at: { type: 'string', nullable: true },
            last_replied_at: { type: 'string', nullable: true },
            created_at: { type: 'string' },
            updated_at: { type: 'string' },
          },
        },
        CustomerSummary: {
          allOf: [
            { $ref: '#/components/schemas/Customer' },
            {
              type: 'object',
              properties: {
                emails_count: { type: 'integer' },
                replies_count: { type: 'integer' },
                last_intent: {
                  type: 'string',
                  nullable: true,
                  enum: ['interested', 'needs_info', 'rejected', 'neutral', null],
                },
                last_event_at: { type: 'string', nullable: true },
              },
            },
          ],
        },
        EmailMessage: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            customer_id: { type: 'integer' },
            run_id: { type: 'string', nullable: true },
            direction: { type: 'string', enum: ['outbound', 'inbound'] },
            subject: { type: 'string' },
            body: { type: 'string' },
            status: { type: 'string', enum: ['draft', 'sent', 'failed'] },
            model: { type: 'string', nullable: true },
            prompt_tokens: { type: 'integer' },
            completion_tokens: { type: 'integer' },
            latency_ms: { type: 'integer' },
            mock: { type: 'boolean' },
            sent_at: { type: 'string', nullable: true },
            created_at: { type: 'string' },
          },
        },
        Reply: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            customer_id: { type: 'integer' },
            email_message_id: { type: 'integer', nullable: true },
            body: { type: 'string' },
            intent: {
              type: 'string',
              nullable: true,
              enum: ['interested', 'needs_info', 'rejected', 'neutral', null],
            },
            confidence: { type: 'number', nullable: true },
            sentiment: { type: 'string', nullable: true },
            summary: { type: 'string', nullable: true },
            suggested_action: { type: 'string', nullable: true },
            needs_human: { type: 'boolean' },
            model: { type: 'string', nullable: true },
            prompt_tokens: { type: 'integer' },
            completion_tokens: { type: 'integer' },
            latency_ms: { type: 'integer' },
            mock: { type: 'boolean' },
            from_status: { $ref: '#/components/schemas/CustomerStatus' },
            to_status: { $ref: '#/components/schemas/CustomerStatus' },
            created_at: { type: 'string' },
          },
        },
        Event: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            event_type: { type: 'string', example: 'status_changed' },
            from_status: { type: 'string', nullable: true },
            to_status: { type: 'string', nullable: true },
            trigger: { type: 'string', example: 'classify_reply' },
            run_id: { type: 'string', nullable: true },
            actor: { type: 'string' },
            payload: { type: 'object', nullable: true },
            created_at: { type: 'string' },
          },
        },
        LeadImportItem: {
          type: 'object',
          required: ['company_name', 'email'],
          properties: {
            company_name: { type: 'string', example: 'Beijing Quantum Robotics' },
            contact_name: { type: 'string', nullable: true, example: 'Liu Yang' },
            email: {
              type: 'string',
              format: 'email',
              example: 'liu.yang@quantum-robotics.example.com',
            },
            phone: { type: 'string', nullable: true },
            website: { type: 'string', nullable: true },
            industry: { type: 'string', nullable: true, example: '工业机器人' },
            country: { type: 'string', nullable: true, example: 'CN' },
            company_size: { type: 'string', nullable: true, example: '100-500' },
            source: { type: 'string', nullable: true, example: 'webinar' },
            notes: { type: 'string', nullable: true, example: '展会收集，明确采购需求' },
          },
        },
        AgentStep: {
          type: 'object',
          properties: {
            step_index: { type: 'integer' },
            tool: { type: 'string', enum: TOOL_CATALOG.map((tool) => tool.name) },
            status: { type: 'string', enum: ['succeeded', 'failed'] },
            input: { type: 'object', nullable: true },
            output: { type: 'object', nullable: true },
            error: { type: 'string', nullable: true },
            duration_ms: { type: 'integer' },
            created_at: { type: 'string' },
          },
        },
        LlmCall: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            run_id: { type: 'string', nullable: true },
            operation: {
              type: 'string',
              enum: ['generate_email', 'classify_intent', 'suggest_next_action'],
            },
            provider: { type: 'string', example: 'deepseek' },
            model: { type: 'string', example: 'deepseek-flash' },
            prompt_tokens: { type: 'integer' },
            completion_tokens: { type: 'integer' },
            total_tokens: { type: 'integer' },
            latency_ms: { type: 'integer' },
            cost_usd: { type: 'number' },
            status: { type: 'string', enum: ['success', 'error', 'fallback'] },
            attempt: { type: 'integer' },
            mock: { type: 'boolean' },
            error: { type: 'string', nullable: true },
            created_at: { type: 'string' },
          },
        },
      },
    },
  },
  apis: [routeGlob, routeGlobJs],
};

export const buildOpenApiSpec = (): Record<string, unknown> =>
  swaggerJsdoc(openapiOptions) as Record<string, unknown>;

export default buildOpenApiSpec;
