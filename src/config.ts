/**
 * 配置中心：所有环境变量集中在此读取并用 Zod 校验。
 * 规范见 AGENTS.md 第 12 节。
 */
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

// quiet: 关闭 dotenv 的注解输出，避免污染 CLI / 测试输出
dotenv.config({ quiet: true });

/** 空字符串视为未设置（.env.example 里 LLM_API_KEY= 即 Mock 模式） */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const numeric = (def: number) =>
  z.preprocess((v) => {
    const cleaned = emptyToUndefined(v);
    if (cleaned === undefined) return def;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : cleaned;
  }, z.number().int().positive());

const configSchema = z.object({
  NODE_ENV: z.preprocess(
    emptyToUndefined,
    z.enum(['development', 'test', 'production']).default('development'),
  ),
  PORT: numeric(3000),
  LOG_LEVEL: z.preprocess(
    emptyToUndefined,
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  ),

  // LLM 网关
  LLM_API_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  LLM_BASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().url().default('https://api.deepseek.com'),
  ),
  LLM_MODEL: z.preprocess(emptyToUndefined, z.string().default('deepseek-flash')),
  LLM_TIMEOUT_MS: numeric(60000),
  LLM_MAX_RETRIES: numeric(3),
  LLM_PROVIDER: z.preprocess(
    emptyToUndefined,
    z.enum(['deepseek', 'openai', 'doubao', 'custom', 'mock']).default('deepseek'),
  ),
  /**
   * 思考模式（DeepSeek 特有，默认 disabled）
   * DeepSeek 的 thinking 默认开启，会先输出思维链 reasoning_content 再给 content。
   * 本项目只消费 content，且意图分类要求严格 JSON，因此默认关闭：
   *   - 省 token（思维链按输出 token 计费）
   *   - 避免思维链干扰 JSON 抽取
   * 对不支持该参数的提供商（OpenAI / 豆包），设为 disabled 时不会发送该字段。
   */
  LLM_THINKING: z.preprocess(
    emptyToUndefined,
    z.enum(['enabled', 'disabled', 'minimal', 'low', 'high', 'max']).default('disabled'),
  ),

  // 数据库
  DATABASE_PATH: z.preprocess(emptyToUndefined, z.string().default('./sales-agent.db')),

  // 前端
  FRONTEND_PORT: numeric(5173),
});

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // 配置错误直接抛出：进程无法在无配置下安全运行
  throw new Error(`环境变量校验失败(CONFIG_ERROR):\n${issues}\n请参考 .env.example 修正 .env`);
}

const raw = parsed.data;

/** LLM_API_KEY 为空 → Mock 模式（AGENTS.md 第 5 节要求） */
export const isMockMode = !raw.LLM_API_KEY || raw.LLM_PROVIDER === 'mock';

export const config = {
  env: raw.NODE_ENV,
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  logLevel: raw.LOG_LEVEL,

  llm: {
    apiKey: raw.LLM_API_KEY ?? '',
    baseUrl: raw.LLM_BASE_URL.replace(/\/+$/, ''),
    model: raw.LLM_MODEL,
    timeoutMs: raw.LLM_TIMEOUT_MS,
    maxRetries: raw.LLM_MAX_RETRIES,
    provider: isMockMode ? ('mock' as const) : raw.LLM_PROVIDER,
    mock: isMockMode,
    /** 思考模式开关 / 强度（仅 DeepSeek 支持；disabled 时不发送该字段） */
    thinking: raw.LLM_THINKING,
    /** 单次响应最大 token（分类任务输出很短） */
    maxTokens: 900,
    temperature: 0.4,
  },

  databasePath: path.isAbsolute(raw.DATABASE_PATH)
    ? raw.DATABASE_PATH
    : path.resolve(process.cwd(), raw.DATABASE_PATH),

  frontendPort: raw.FRONTEND_PORT,
} as const;

export type AppConfig = typeof config;
export default config;
