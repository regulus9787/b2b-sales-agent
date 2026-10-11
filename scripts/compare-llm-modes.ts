/**
 * 同客户双模式对比：用 Mock 与真实 LLM 分别对同一客户生成邮件 + 分类回复
 *   npx tsx scripts/compare-llm-modes.ts [customerId]
 *
 * 用于产出 docs/LLM-COMPARISON.md 里的横向对比数据。
 * 需要 .env 已配置 LLM_API_KEY；Mock 侧通过 per-call 覆盖强制走 Mock 分支。
 * 使用独立内存库 + seed 数据，不影响开发库。
 */
import { openDatabase } from '../src/db/db';
import { seedDatabase } from '../src/db/seed';
import { getCustomerSummary } from '../src/services/customer';
import { buildEmailMessages } from '../src/services/prompts';
import { callLlmRaw } from '../src/services/llm';
import { classifyReplyText } from '../src/services/reply';
import { mockCustomerReply } from '../src/services/llm-mock';
import config from '../src/config';
import type { ReplyIntent } from '../src/core/status';

const customerId = Number(process.argv[2] ?? '1');
const INTENT: ReplyIntent = 'interested';

interface Row {
  mode: string;
  model: string;
  emailMs: number;
  emailIn: number;
  emailOut: number;
  emailCost: number;
  classifyMs: number;
  classifyIn: number;
  classifyOut: number;
  classifyCost: number;
  classifyModel: string;
  fallback: boolean;
  intent: string;
  confidence: number;
  summary: string;
  action: string;
  subject: string;
  body: string;
}

const main = async (): Promise<void> => {
  const db = openDatabase({ filename: ':memory:' });
  seedDatabase(db, { silent: true });

  const customer = getCustomerSummary(db, customerId);
  const replyText = mockCustomerReply(INTENT, {
    contactName: customer.contact_name,
    companyName: customer.company_name,
    senderName: 'Alex Chen',
  });

  console.log('客户画像：');
  console.log(`  #${customer.id} ${customer.company_name}`);
  console.log(`  联系人=${customer.contact_name} 行业=${customer.industry} 地区=${customer.country} 规模=${customer.company_size} 评分=${customer.score}`);
  console.log(`\n待分类的模拟客户回复（${INTENT}）：\n${replyText}\n`);

  const messages = buildEmailMessages({
    company_name: customer.company_name,
    contact_name: customer.contact_name,
    industry: customer.industry,
    country: customer.country,
    company_size: customer.company_size,
    website: customer.website,
    score: customer.score,
    language: '中文为主，保留英文专业术语',
  });

  const rows: Row[] = [];
  const scenarios: { label: string; mock: boolean }[] = [
    { label: 'MOCK', mock: true },
    { label: 'LIVE', mock: false },
  ];

  for (const scenario of scenarios) {
    console.log(`${'='.repeat(72)}`);
    console.log(`### ${scenario.label} 模式`);
    console.log('='.repeat(72));

    const emailStart = Date.now();
    const email = await callLlmRaw({
      operation: 'generate_email',
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.user },
      ],
      mock: scenario.mock,
      maxRetries: 1,
    });
    const emailMs = Date.now() - emailStart;

    const subjectLine = email.content.split('\n')[0] ?? '';
    console.log(
      `\n[generate_email] ${emailMs}ms | tokens ${email.usage.prompt_tokens}/${email.usage.completion_tokens} | cost $${email.costUsd}`,
    );
    console.log(`主题行: ${subjectLine}`);
    console.log('正文:');
    console.log(email.content);

    const classifyStart = Date.now();
    const outcome = await classifyReplyText(
      {
        replyText,
        companyName: customer.company_name,
        contactName: customer.contact_name,
        industry: customer.industry,
        status: 'replied',
        emailSubject: subjectLine,
      },
      { db, mock: scenario.mock },
    );
    const classifyMs = Date.now() - classifyStart;

    console.log(
      `\n[classify_intent] ${classifyMs}ms | provider=${outcome.provider} model=${outcome.model} | tokens ${outcome.prompt_tokens}/${outcome.completion_tokens} | cost $${outcome.cost_usd} | fallback=${outcome.fallback}\n`,
    );
    console.log(JSON.stringify(outcome.classification, null, 2));
    console.log('');

    rows.push({
      mode: scenario.label,
      model: email.model,
      emailMs,
      emailIn: email.usage.prompt_tokens,
      emailOut: email.usage.completion_tokens,
      emailCost: email.costUsd,
      classifyMs,
      classifyIn: outcome.prompt_tokens,
      classifyOut: outcome.completion_tokens,
      classifyCost: outcome.cost_usd,
      classifyModel: `${outcome.provider}/${outcome.model}`,
      fallback: outcome.fallback,
      intent: outcome.classification.intent,
      confidence: outcome.classification.confidence,
      summary: outcome.classification.summary,
      action: outcome.classification.suggested_action,
      subject: subjectLine,
      body: email.content,
    });
  }

  console.log(`${'='.repeat(72)}`);
  console.log('### 汇总（可直接粘进文档）');
  console.log('='.repeat(72));
  console.log(
    JSON.stringify(
      rows.map((row) => ({
        mode: row.mode,
        email: `${row.emailMs}ms / ${row.emailIn}+${row.emailOut} tok / $${row.emailCost}`,
        classify: `${row.classifyMs}ms / ${row.classifyIn}+${row.classifyOut} tok / $${row.classifyCost} (${row.classifyModel})`,
        intent: `${row.intent} (${row.confidence})`,
        totalCost: Number((row.emailCost + row.classifyCost).toFixed(8)),
      })),
      null,
      2,
    ),
  );
  console.log(`\n当前 live 模型: ${config.llm.model} | thinking=${config.llm.thinking}`);

  db.close();
};

main().catch((error: unknown) => {
  console.error('对比失败:', error);
  process.exitCode = 1;
});
