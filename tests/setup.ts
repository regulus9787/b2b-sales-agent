/**
 * Vitest 全局初始化（每个测试文件运行一次，早于测试用例）
 *
 * 关键作用：**强制测试走 Mock 模式**。
 * 一旦 .env 里配置了真实 LLM_API_KEY，测试若走真实 API 会带来三个问题：
 *   1. 花钱（每次 `npm test` 都会真实调用几十次）；
 *   2. 不稳定（网络抖动、限流、模型措辞变化会让断言随机失败）；
 *   3. 变慢（从 ~6s 涨到 ~170s，且可能出现 20s 超时）。
 *
 * 需要验证真实调用链路的测试，请用 per-call 覆盖：`callLlmRaw({ ...liveOptions })`
 * （见 tests/unit/llm.test.ts 里的 `liveOptions`）。
 */
import config from '../src/config';

// config 声明为 `as const`（生产不可变），测试中需要显式改写，故做一次窄化转换
const mutableLlm = config.llm as { mock: boolean; apiKey: string };
mutableLlm.mock = true;
mutableLlm.apiKey = '';
