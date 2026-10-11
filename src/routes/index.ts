/**
 * 路由汇总（AGENTS.md 第 2 节：routes 只做薄层）
 *
 * 路由文件内部只声明相对路径（如 '/customers'），
 * 由本文件统一挂载到 /api 前缀；/health 保持在根路径与 Docker healthcheck 对齐。
 */
import { Router } from 'express';
import healthRouter from './health';
import customersRouter from './customers';
import leadsRouter from './leads';
import emailRouter from './email';
import replyRouter from './reply';
import agentRouter from './agent';
import dashboardRouter from './dashboard';

const apiRouter = Router();
apiRouter.use(customersRouter);
apiRouter.use(leadsRouter);
apiRouter.use(emailRouter);
apiRouter.use(replyRouter);
apiRouter.use(agentRouter);
apiRouter.use(dashboardRouter);

const router = Router();
router.use(healthRouter);
router.use('/api', apiRouter);

export default router;
