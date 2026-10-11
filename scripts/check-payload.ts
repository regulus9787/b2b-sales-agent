/**
 * 验证请求体构造：默认关闭思考模式时是否真的发送 thinking: { type: 'disabled' }
 *   npx tsx scripts/check-payload.ts
 */
import { callLlmRaw } from '../src/services/llm';
import config from '../src/config';

const main = async (): Promise<void> => {
  console.log('当前配置：');
  console.log('  base_url =', config.llm.baseUrl);
  console.log('  model    =', config.llm.model);
  console.log('  thinking =', config.llm.thinking);
  console.log('  mock     =', config.llm.mock);
  console.log('  timeout  =', config.llm.timeoutMs, 'ms');

  let captured: Record<string, unknown> | null = null;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: 'deepseek-flash',
        choices: [{ message: { content: 'SUBJECT: 测试\n---\n正文内容测试' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  await callLlmRaw({
    operation: 'generate_email',
    messages: [{ role: 'user', content: 'ping' }],
    fetchImpl,
    mock: false,
    apiKey: 'test-key-not-real',
    maxRetries: 0,
  });

  console.log('\n实际发送的请求体字段：');
  console.log(' ', JSON.stringify(captured, null, 2).replace(/\n/g, '\n  '));
};

main().catch((error: unknown) => {
  console.error('失败:', error);
  process.exitCode = 1;
});
