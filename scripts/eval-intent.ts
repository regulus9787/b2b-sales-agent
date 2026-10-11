/**
 * 意图分类评估（AGENTS.md 第 10 节）
 *   npm run eval:intent
 *
 * - 内置 26 条标注回复样本（data/intent-eval.jsonl）
 * - 逐条走 LLM 网关（Mock 模式使用规则分类器）
 * - 输出整体准确率、混淆矩阵、每条明细、平均耗时与 token
 * - 可选参数：--limit N 只跑前 N 条；--json 输出机器可读结果
 * - 可用 EVAL_MIN_ACCURACY 调整通过阈值（默认 80%）
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '../src/db/db';
import config from '../src/config';
import { classifyReplyText } from '../src/services/reply';
import { REPLY_INTENTS, type ReplyIntent } from '../src/core/status';

const DOLLAR = String.fromCharCode(36);

const sampleSchema = z.object({
  id: z.string(),
  label: z.enum(REPLY_INTENTS),
  reply: z.string().min(1),
});

export type Sample = z.infer<typeof sampleSchema>;

export interface SampleResult {
  id: string;
  expected: ReplyIntent;
  predicted: ReplyIntent;
  correct: boolean;
  confidence: number;
  latency_ms: number;
  tokens: number;
  fallback: boolean;
  reply: string;
}

export interface EvalSummary {
  mode: string;
  model: string;
  samples: number;
  correct: number;
  accuracy: number;
  avg_latency_ms: number;
  total_tokens: number;
  fallbacks: number;
  per_intent: Record<string, { total: number; correct: number; accuracy: number }>;
  results: SampleResult[];
}

const datasetPath = path.resolve(__dirname, '../data/intent-eval.jsonl');

export const loadSamples = (file: string = datasetPath): Sample[] => {
  if (!fs.existsSync(file)) {
    throw new Error(`样本文件不存在: ${file}`);
  }
  const lines = fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'));

  return lines.map((line, index) => {
    try {
      return sampleSchema.parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`第 ${index + 1} 行样本格式错误: ${(error as Error).message}`);
    }
  });
};

export const runEvaluation = async (
  samples: Sample[],
): Promise<{
  results: SampleResult[];
  accuracy: number;
  confusion: Record<string, Record<string, number>>;
  avgLatencyMs: number;
  totalTokens: number;
  fallbacks: number;
}> => {
  const results: SampleResult[] = [];

  for (const sample of samples) {
    const outcome = await classifyReplyText({
      replyText: sample.reply,
      companyName: 'Eval Corp',
      contactName: 'Eval Contact',
      industry: 'SaaS 软件',
      status: 'replied',
      emailSubject: 'B2B 线索转化方案',
    });

    const predicted = outcome.classification.intent;
    results.push({
      id: sample.id,
      expected: sample.label,
      predicted,
      correct: predicted === sample.label,
      confidence: outcome.classification.confidence,
      latency_ms: outcome.latency_ms,
      tokens: outcome.prompt_tokens + outcome.completion_tokens,
      fallback: outcome.fallback,
      reply: sample.reply,
    });
  }

  const correct = results.filter((result) => result.correct).length;
  const accuracy = results.length === 0 ? 0 : correct / results.length;

  const confusion: Record<string, Record<string, number>> = {};
  for (const label of REPLY_INTENTS) {
    const row: Record<string, number> = {};
    for (const predicted of REPLY_INTENTS) {
      row[predicted] = 0;
    }
    confusion[label] = row;
  }
  for (const result of results) {
    const row = confusion[result.expected];
    if (row) {
      row[result.predicted] = (row[result.predicted] ?? 0) + 1;
    }
  }

  const avgLatencyMs =
    results.length === 0
      ? 0
      : Math.round(results.reduce((sum, item) => sum + item.latency_ms, 0) / results.length);
  const totalTokens = results.reduce((sum, item) => sum + item.tokens, 0);
  const fallbacks = results.filter((result) => result.fallback).length;

  return { results, accuracy, confusion, avgLatencyMs, totalTokens, fallbacks };
};

const pad = (value: string, width: number): string => value.padEnd(width, ' ');

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const limitIndex = args.indexOf('--limit');
  const limit = limitIndex >= 0 ? Number(args[limitIndex + 1] ?? '0') : 0;

  const allSamples = loadSamples();
  const samples = limit > 0 ? allSamples.slice(0, limit) : allSamples;
  const db = getDb();

  if (!jsonOutput) {
    console.log('=========================================================');
    console.log(' B2B Sales Agent —— 意图分类评估 (npm run eval:intent)');
    console.log('=========================================================');
    console.log(
      '模式      : ' +
        (config.llm.mock
          ? 'Mock（规则分类器，无需 API Key）'
          : '真实 LLM（' + config.llm.provider + ' / ' + config.llm.model + '）'),
    );
    console.log('样本文件  : ' + datasetPath);
    console.log('样本数    : ' + samples.length);
    console.log('---------------------------------------------------------');
  }

  const { results, accuracy, confusion, avgLatencyMs, totalTokens, fallbacks } =
    await runEvaluation(samples);

  if (!jsonOutput) {
    console.log(pad('ID', 6) + pad('期望', 12) + pad('预测', 12) + pad('结果', 6) + '置信度  耗时');
    console.log('---------------------------------------------------------');
    for (const result of results) {
      console.log(
        pad(result.id, 6) +
          pad(result.expected, 12) +
          pad(result.predicted, 12) +
          pad(result.correct ? 'OK' : 'X', 6) +
          String(result.confidence).padEnd(8) +
          result.latency_ms +
          'ms' +
          (result.fallback ? '  [降级]' : ''),
      );
      if (!result.correct) {
        console.log('      -> 回复: ' + result.reply.slice(0, 70) + '…');
      }
    }

    console.log('---------------------------------------------------------');
    console.log('混淆矩阵（行=期望，列=预测）');
    console.log(pad('', 12) + REPLY_INTENTS.map((intent) => pad(intent, 12)).join(''));
    for (const expected of REPLY_INTENTS) {
      const row = confusion[expected] ?? {};
      console.log(
        pad(expected, 12) +
          REPLY_INTENTS.map((predicted) => pad(String(row[predicted] ?? 0), 12)).join(''),
      );
    }
    console.log('---------------------------------------------------------');
  }

  const correct = results.filter((result) => result.correct).length;
  const perIntent: EvalSummary['per_intent'] = {};
  for (const intent of REPLY_INTENTS) {
    const total = results.filter((result) => result.expected === intent).length;
    const hit = results.filter((result) => result.expected === intent && result.correct).length;
    perIntent[intent] = {
      total,
      correct: hit,
      accuracy: total === 0 ? 0 : Number(((hit / total) * 100).toFixed(2)),
    };
  }

  const summary: EvalSummary = {
    mode: config.llm.mock ? 'mock' : 'live',
    model: config.llm.mock ? 'mock(rule-based)' : config.llm.model,
    samples: results.length,
    correct,
    accuracy: Number((accuracy * 100).toFixed(2)),
    avg_latency_ms: avgLatencyMs,
    total_tokens: totalTokens,
    fallbacks,
    per_intent: perIntent,
    results,
  };

  if (jsonOutput) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      '总准确率  : ' + (accuracy * 100).toFixed(2) + '%  (' + correct + '/' + results.length + ')',
    );
    console.log('平均耗时  : ' + avgLatencyMs + 'ms');
    console.log('总 tokens : ' + totalTokens);
    console.log('降级次数  : ' + fallbacks);
    console.log('分类别准确率：');
    for (const [intent, stat] of Object.entries(perIntent)) {
      console.log(
        '  - ' +
          pad(intent, 12) +
          String(stat.accuracy).padStart(6) +
          '%  (' +
          stat.correct +
          '/' +
          stat.total +
          ')',
      );
    }
    const threshold = Number(process.env.EVAL_MIN_ACCURACY ?? '80');
    const passed = accuracy * 100 >= threshold;
    console.log('---------------------------------------------------------');
    console.log(
      (passed ? 'PASS' : 'FAIL') + '：准确率阈值 ' + threshold + '%（可用 EVAL_MIN_ACCURACY 调整）',
    );
    console.log('提示：成本与调用明细已写入 llm_calls 表，可用 npm run init-db 后查询。');
    void DOLLAR;
  }

  db.close();

  const threshold = Number(process.env.EVAL_MIN_ACCURACY ?? '80');
  if (accuracy * 100 < threshold) {
    process.exitCode = 1;
  }
};

const isDirectRun = (): boolean => {
  // CommonJS 下用 require.main 判断是否被直接执行（tsx 运行 .ts 走 CommonJS）
  if (typeof require !== 'undefined' && typeof module !== 'undefined') {
    return require.main === module;
  }
  return true;
};

if (isDirectRun()) {
  main().catch((error: unknown) => {
    console.error('评估失败:', error);
    process.exitCode = 1;
  });
}

export { main as runEvalCli };
