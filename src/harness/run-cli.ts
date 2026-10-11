/**
 * Agent 工作流 CLI（可选，用于本地演示）
 *
 *   npx tsx src/harness/run-cli.ts --customer 1
 *   npx tsx src/harness/run-cli.ts --customer 1 --intent interested
 *   npx tsx src/harness/run-cli.ts --workflow import_and_draft --leads-file ./data/leads-sample.json
 *
 * 等价 npm 脚本：npm run agent:run -- --customer 1
 */
import fs from 'node:fs';
import { getDb } from '../db/db';
import { executeAndSummarize, WORKFLOWS, type WorkflowName } from './workflow';
import type { ReplyIntent } from '../core/status';
import { listToolNames } from './runner';

interface CliArgs {
  workflow: WorkflowName;
  customer?: number;
  intent?: ReplyIntent;
  leadsFile?: string;
  sendEmail: boolean;
  limit: number;
  help: boolean;
}

const parseArgs = (argv: string[]): CliArgs => {
  const args: CliArgs = {
    workflow: 'full_cycle',
    sendEmail: true,
    limit: 1,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    switch (arg) {
      case '--workflow':
        if (next && (WORKFLOWS as readonly string[]).includes(next)) {
          args.workflow = next as WorkflowName;
          i += 1;
        }
        break;
      case '--customer':
      case '--customer-id':
        if (next) {
          args.customer = Number(next);
          i += 1;
        }
        break;
      case '--intent':
        if (next) {
          args.intent = next as ReplyIntent;
          i += 1;
        }
        break;
      case '--leads-file':
        if (next) {
          args.leadsFile = next;
          i += 1;
        }
        break;
      case '--limit':
        if (next) {
          args.limit = Number(next);
          i += 1;
        }
        break;
      case '--no-send':
        args.sendEmail = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        break;
    }
  }

  return args;
};

const printHelp = (): void => {
  // eslint-disable-next-line no-console
  console.log(`
B2B Sales Agent —— 工作流 CLI

用法：
  npx tsx src/harness/run-cli.ts --customer <id> [--intent interested|needs_info|rejected|neutral]
  npx tsx src/harness/run-cli.ts --workflow import_and_draft --leads-file ./data/leads-sample.json [--limit 2]
  npx tsx src/harness/run-cli.ts --workflow classify_only --customer <id> --intent rejected

参数：
  --workflow <name>   ${WORKFLOWS.join(' | ')}（默认 full_cycle）
  --customer <id>     目标客户 ID
  --intent <intent>   模拟客户回复的意图
  --leads-file <path> 线索 JSON 文件（数组）
  --limit <n>         import_and_draft 处理的客户数（默认 1）
  --no-send           只生成草稿，不标记为已发送

已注册工具：${listToolNames().join(', ')}
`);
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    return;
  }

  const db = getDb();

  let leads: unknown[] | undefined;
  if (args.leadsFile) {
    const raw = fs.readFileSync(args.leadsFile, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    leads = Array.isArray(parsed) ? parsed : [parsed];
  }

  const result = await executeAndSummarize(db, {
    workflow: args.workflow,
    customerId: args.customer,
    leads: leads as never,
    simulateIntent: args.intent,
    sendEmail: args.sendEmail,
    limit: args.limit,
    trigger: 'cli',
  });

  // eslint-disable-next-line no-console
  console.log(`\n=== Agent Run ${result.run_id} ===`);
  // eslint-disable-next-line no-console
  console.log(`工作流: ${result.workflow}｜状态: ${result.status}｜耗时: ${result.duration_ms}ms`);
  // eslint-disable-next-line no-console
  console.log(
    `LLM 调用: ${result.llm_calls_count} 次｜tokens: ${result.total_tokens}｜成本: $${result.total_cost_usd}`,
  );
  // eslint-disable-next-line no-console
  console.log('\n--- 步骤 ---');
  for (const step of result.steps) {
    // eslint-disable-next-line no-console
    console.log(
      `${step.step_index}. [${step.status}] ${step.tool} (${step.duration_ms}ms) → ${step.summary}`,
    );
  }

  if (result.output) {
    // eslint-disable-next-line no-console
    console.log('\n--- 客户结果 ---');
    for (const customer of result.output.customers) {
      // eslint-disable-next-line no-console
      console.log(
        `客户 #${customer.customer_id} ${customer.company_name}｜${customer.from_status} → ${customer.to_status}` +
          `${customer.intent ? `｜意图 ${customer.intent}(${customer.confidence})` : ''}` +
          `${customer.next_action ? `｜下一步：${customer.next_action}` : ''}`,
      );
      if (customer.email_subject) {
        // eslint-disable-next-line no-console
        console.log(`  邮件主题: ${customer.email_subject}`);
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `\n合计：客户 ${result.output.totals.customers}｜邮件 ${result.output.totals.emails}｜回复 ${result.output.totals.replies}｜tokens ${result.output.totals.tokens}｜成本 $${result.output.totals.cost_usd}`,
    );
  }

  if (result.error) {
    // eslint-disable-next-line no-console
    console.error(`\n错误: ${result.error}`);
    process.exitCode = 1;
  }

  db.close();
};

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('CLI 执行失败:', error);
  process.exitCode = 1;
});
