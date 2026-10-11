/**
 * async 路由包装器
 * Express 5 已经会把 async 处理器的 rejection 交给错误中间件，
 * 这里提供显式包装，保证在所有调用方式下错误都能进入统一错误处理。
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export const asyncRoute =
  (handler: AsyncRequestHandler): RequestHandler =>
  (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res, next).catch(next);
  };

export default asyncRoute;
