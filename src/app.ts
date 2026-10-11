/**
 * Express 5 应用装配（AGENTS.md 第 2 / 6 / 7 节）
 *  - request_id（crypto.randomUUID）
 *  - pino HTTP 日志（method/path/status/duration_ms/request_id）
 *  - Zod 校验 + 统一响应信封 + 统一错误处理
 *  - Swagger UI 挂载在 /docs
 */
import express, { type Express } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import routes from './routes';
import { requestIdMiddleware } from './middleware/requestId';
import { httpLogger } from './middleware/logger';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { buildOpenApiSpec } from './docs/openapi';
import { ok } from './middleware/response';
import { getDb } from './db/db';
import config from './config';

export interface CreateAppOptions {
  /** 是否挂载 Swagger UI，默认 true */
  swagger?: boolean;
  /** 是否跳过数据库预热，默认 false */
  skipDbWarmup?: boolean;
}

export const createApp = (options: CreateAppOptions = {}): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // 1) request_id 必须最先执行，后续日志与响应都依赖它
  app.use(requestIdMiddleware);
  app.use(httpLogger as unknown as express.RequestHandler);

  // 2) 通用中间件
  app.use(cors({ origin: true, exposedHeaders: ['x-request-id'] }));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: true }));
  // 允许 GET 请求携带 JSON body（少数客户端会这样做）
  app.use(express.text({ type: ['text/plain'], limit: '2mb' }));

  // 3) 根路径：服务信息（避免访问根路径 404 造成误解）
  app.get('/', (_req, res) =>
    ok(res, {
      name: 'B2B Sales Agent API',
      version: '1.0.0',
      docs: '/docs',
      health: '/health',
      llm_mode: config.llm.mock ? 'mock' : 'live',
      endpoints: [
        'GET  /health',
        'GET  /api/customers?page=1&pageSize=20&status=interested&search=nova',
        'GET  /api/customers/:id',
        'GET  /api/customers/status-machine',
        'POST /api/leads/import',
        'POST /api/email/generate/:customerId',
        'POST /api/reply/analyze/:customerId',
        'POST /api/agent/run',
        'GET  /api/agent/tools',
        'GET  /api/agent/runs',
        'GET  /api/agent/runs/:runId',
        'GET  /api/dashboard/stats',
        'GET  /api/leads',
      ],
    }),
  );

  // 4) Swagger UI
  if (options.swagger !== false) {
    const spec = buildOpenApiSpec();
    app.get('/docs/openapi.json', (_req, res) => {
      res.json(spec);
    });
    app.use(
      '/docs',
      swaggerUi.serve,
      swaggerUi.setup(spec, {
        customSiteTitle: 'B2B Sales Agent API Docs',
        swaggerOptions: {
          persistAuthorization: true,
          docExpansion: 'list',
          defaultModelsExpandDepth: 1,
        },
      }),
    );
  }

  // 5) 业务路由（先预热数据库连接：首次请求即可用，避免 SQLITE_CANTOPEN 延迟暴露）
  app.use((_req, _res, next) => {
    if (!options.skipDbWarmup) {
      getDb();
    }
    next();
  });
  app.use(routes);

  // 6) 404 与错误处理（必须最后注册）
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

export default createApp;
