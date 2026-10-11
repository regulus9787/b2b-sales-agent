/**
 * pino 日志（AGENTS.md 第 7 节：输出 JSON，记录 method/path/status/duration_ms/request_id）
 */
import pino from 'pino';
import pinoHttp from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import config from '../config';

export const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  base: { service: 'b2b-sales-agent', env: config.env },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

/** HTTP 访问日志中间件 */
export const httpLogger = pinoHttp({
  logger,
  genReqId: (req: IncomingMessage, res: ServerResponse) => {
    const resLocals = (res as ServerResponse & { locals?: { requestId?: string } }).locals;
    const existing = resLocals?.requestId;
    if (existing) return existing;
    const header = req.headers['x-request-id'];
    if (typeof header === 'string' && header.length > 0) return header;
    return randomUUID();
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res, responseTime) =>
    `${req.method} ${req.url} ${res.statusCode} ${Math.round(responseTime)}ms`,
  serializers: {
    req(req: IncomingMessage & { id?: string }) {
      return { method: req.method, path: req.url, request_id: req.id };
    },
    res(res: ServerResponse & { statusCode: number }) {
      return { status: res.statusCode };
    },
  },
  customProps: (_req, res) => {
    const resLocals = (res as ServerResponse & { locals?: { requestId?: string } }).locals;
    return { request_id: resLocals?.requestId };
  },
});

export default logger;
