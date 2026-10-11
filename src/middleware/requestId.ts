/**
 * request_id 中间件（AGENTS.md 第 6 节：使用 crypto.randomUUID()）
 * 把 request_id 写入 res.locals，供统一响应信封与日志使用。
 */
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      requestId: string;
    }
    interface Request {
      /** 由 requestId 中间件注入 */
      requestId?: string;
    }
  }
}

export const REQUEST_ID_HEADER = 'x-request-id';

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.header(REQUEST_ID_HEADER);
  const id = incoming && incoming.trim().length > 0 ? incoming.trim() : randomUUID();
  res.locals.requestId = id;
  req.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
};

export default requestIdMiddleware;
