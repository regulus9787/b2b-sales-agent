/**
 * 服务入口：npm run dev / npm start
 */
import createApp from './app';
import config from './config';
import { logger } from './middleware/logger';
import { closeDb, getDb } from './db/db';
import { getSchemaVersion, listTables } from './db/migrations';
import { listToolNames } from './harness/runner';

const bootstrap = (): void => {
  const app = createApp();

  // 启动即建连 + 迁移，让配置/权限问题在启动阶段暴露
  const db = getDb();
  const tables = listTables(db);
  const schemaVersion = getSchemaVersion(db);

  logger.info(
    {
      database_path: config.databasePath,
      schema_version: schemaVersion,
      tables: tables.length,
      llm_mode: config.llm.mock ? 'mock' : 'live',
      llm_provider: config.llm.provider,
      llm_model: config.llm.mock ? 'mock' : config.llm.model,
      agent_tools: listToolNames(),
    },
    'database_ready',
  );

  const server = app.listen(config.port, () => {
    logger.info(
      {
        port: config.port,
        env: config.env,
        docs: `http://localhost:${config.port}/docs`,
        health: `http://localhost:${config.port}/health`,
        mock_mode: config.llm.mock,
      },
      'server_started',
    );
    // eslint-disable-next-line no-console
    console.log(`
=========================================================
 B2B Sales Agent 已启动
   API      : http://localhost:${config.port}
   Swagger  : http://localhost:${config.port}/docs
   Health   : http://localhost:${config.port}/health
   LLM 模式 : ${config.llm.mock ? 'Mock（未配置 LLM_API_KEY，使用内置 Mock）' : `${config.llm.provider} / ${config.llm.model}`}
   数据库   : ${config.databasePath}
   前端     : http://localhost:${config.frontendPort}（npm run dev --prefix frontend）
=========================================================
`);
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'server_shutdown_started');
    server.close(() => {
      closeDb();
      logger.info({ signal }, 'server_shutdown_completed');
      process.exit(0);
    });
    // 兜底：10 秒后强制退出
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled_rejection');
  });
  process.on('uncaughtException', (error) => {
    logger.error({ err: error }, 'uncaught_exception');
    shutdown('uncaughtException');
  });
};

bootstrap();
