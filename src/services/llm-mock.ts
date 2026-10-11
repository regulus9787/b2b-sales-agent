/**
 * Mock LLM（AGENTS.md 第 5 节）
 * LLM_API_KEY 为空时启用：返回确定性的邮件正文与意图分类，保证零密钥可演示、可测试。
 *
 * 设计要点：
 *  - 从 prompt 中解析结构化字段（EMAIL_CONTEXT / REPLY_TEXT），生成"看起来像真的"回复
 *  - classify_intent 使用关键词规则打分，mock 模式下 eval:intent 仍能给出有意义准确率
 *  - 完全确定性：同样输入 → 同样输出（便于测试断言）
 */
import type { LlmMessage } from './llm';
import type { ReplyIntent } from '../core/status';

export interface MockResult {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

const lastUserMessage = (messages: LlmMessage[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === 'user') return message.content;
  }
  return messages.map((m) => m.content).join('\n');
};

/** 从 prompt 中取 "KEY: value" 形式的一行 */
export const pickField = (prompt: string, key: string): string | null => {
  const regex = new RegExp(`^\\s*${key}\\s*[:：]\\s*(.+)$`, 'im');
  const match = prompt.match(regex);
  return match?.[1]?.trim() ?? null;
};

/** 取 REPLY_TEXT 之后的全部内容（模拟回复可能多行） */
export const pickBlock = (prompt: string, key: string): string | null => {
  const regex = new RegExp(`${key}\\s*[:：]\\s*([\\s\\S]*?)(?:\\n\\s*[A-Z_]{3,}\\s*[:：]|$)`, 'i');
  const match = prompt.match(regex);
  return match?.[1]?.trim() ?? null;
};

/* ------------------------------------------------------------------ */
/* 意图分类关键词规则（mock 分类器 + 降级兜底共用）                     */
/* ------------------------------------------------------------------ */

interface IntentRule {
  intent: ReplyIntent;
  patterns: RegExp[];
  weight: number;
}

const INTENT_RULES: IntentRule[] = [
  {
    intent: 'rejected',
    weight: 1,
    patterns: [
      /不(需要|感兴趣|考虑|用了|必了|打算|会)/,
      /没有(这方面(的)?)?(预算|需求|计划)/,
      /(预算|经费)(不足|有限|紧张|已经?用(完|光)|耗尽)/,
      /(停止|不要再)(联系|发送|跟进)/,
      /退订|取消订阅|unsubscribe/i,
      /not interested|no (budget|need|thanks)|please stop|remove me|do not contact/i,
      /已(有|采用)(供应|合作)商/,
      /(暂时|目前)?(不|无)(考虑|打算)/,
      /今年(不会|不)(采购|考虑|购买)/,
    ],
  },
  {
    intent: 'interested',
    weight: 1,
    patterns: [
      /(很|非常)(感兴趣|有意向|看好)/,
      /有(明确)?(合作|采购)(意向|意愿)/,
      /(想|希望|愿意|可以|能否|方便)(进一步|深入)?(沟通|聊聊|了解合作|推进|合作)/,
      /(我们)?(想|希望|计划)(进一步|深入)(了解|沟通|合作)/,
      /(安排|约|开)(个|一次)?(会议|演示|通话|电话|短会|线上会)/,
      /(什么时间|什么时候)(方便|可以)(聊|谈|沟通)/,
      /(安排|约)(个)?(demo|演示)/i,
      /感兴趣/,
      /(发|给)(我|我们)(一份)?(详细)?(报价|方案|提案)/,
      /interested|would love to|let'?s (schedule|set up|talk)|book a (call|demo)|send (me|us) (the )?(quote|proposal)|sounds good/i,
    ],
  },
  {
    intent: 'needs_info',
    weight: 1,
    patterns: [
      /(需要|想|请)(了解|知道|提供|发)(更)?(多)?(详细|具体)?(信息|资料|文档|详情|规格)/,
      /(价格|报价|费用|定价)(是)?(多少|怎样|如何|情况)?/,
      /(多少|什么)(钱|价|价格)|单价/,
      /有没有(案例|白皮书|文档|技术规格|报价单)/,
      /(技术|合规|认证|安全)(细节|文档|报告|要求)/,
      /(怎么|如何)(收费|计价|部署|集成)/,
      /(支持|能否|可以)(私有化|本地)部署/,
      /(实施|交付|对接)周期/,
      /(更多|更详细)(信息|资料|文档)/,
      /(more|additional) (info|information|details|documentation)|(send|share) (me |us )?(the )?(pricing|price|spec|specification|whitepaper|case stud)|how much (does|do) (it|you) cost|what'?s the price|do you have .*(documentation|case stud)/i,
    ],
  },
  {
    intent: 'neutral',
    weight: 1,
    patterns: [
      /收到|谢谢(你的)?(邮件|来信)|已阅|知道了|看到了/,
      /(暂时|目前)(不|没有)(方便|时间)/,
      /(稍后|以后|下次|过段?时间)(再|联系|聊|说)/,
      /(转给|转发给|抄送)(了)?(相关|负责)(的)?(同事|部门|人)/,
      /不是我(负责|分管)/,
      /thanks for (the )?(email|reach(ing)? out)|received|noted|maybe later|circle back|will get back to you/i,
    ],
  },
];

const NEUTRAL_FALLBACK: ReplyIntent = 'neutral';

/** 关键词规则分类：返回意图与命中数（mock 与降级共用） */
export const ruleBasedIntent = (text: string): { intent: ReplyIntent; hits: number } => {
  if (!text || text.trim() === '') return { intent: NEUTRAL_FALLBACK, hits: 0 };

  const scores: Record<ReplyIntent, number> = {
    interested: 0,
    needs_info: 0,
    rejected: 0,
    neutral: 0,
  };

  for (const rule of INTENT_RULES) {
    for (const pattern of rule.patterns) {
      const matched = text.match(
        new RegExp(
          pattern.source,
          pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`,
        ),
      );
      if (matched) scores[rule.intent] += matched.length * rule.weight;
    }
  }

  const priority: ReplyIntent[] = ['rejected', 'interested', 'needs_info', 'neutral'];
  let best: ReplyIntent = NEUTRAL_FALLBACK;
  let bestScore = 0;
  for (const intent of priority) {
    if (scores[intent] > bestScore) {
      best = intent;
      bestScore = scores[intent];
    }
  }
  return { intent: best, hits: bestScore };
};

/** 由分类结果推出置信度（0.62 ~ 0.96），让前端有可读的置信度 */
const confidenceFor = (hits: number, textLength: number): number => {
  const base = 0.62 + Math.min(hits, 5) * 0.06;
  const lengthBonus = textLength > 120 ? 0.04 : 0;
  return Number(Math.min(0.96, base + lengthBonus).toFixed(2));
};

const summaryFor = (intent: ReplyIntent, text: string): string => {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const head = trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
  const map: Record<ReplyIntent, string> = {
    interested: `客户表达明确兴趣，建议尽快推进会议：${head}`,
    needs_info: `客户要求补充资料/报价：${head}`,
    rejected: `客户明确拒绝或预算不匹配：${head}`,
    neutral: `客户中性回复，建议后续跟进：${head}`,
  };
  return map[intent];
};

const suggestedActionFor = (intent: ReplyIntent): string => {
  const map: Record<ReplyIntent, string> = {
    interested: '24 小时内发送会议邀约（附 3 个可选时段）',
    needs_info: '整理技术规格 + 报价单，48 小时内回复',
    rejected: '转入长期培育列表，90 天后自动唤醒',
    neutral: '7 天后发送行业案例跟进邮件',
  };
  return map[intent];
};

const sentimentFor = (intent: ReplyIntent): string => {
  const map: Record<ReplyIntent, string> = {
    interested: 'positive',
    needs_info: 'neutral',
    rejected: 'negative',
    neutral: 'neutral',
  };
  return map[intent];
};

/* ------------------------------------------------------------------ */
/* 邮件生成（Mock）                                                    */
/* ------------------------------------------------------------------ */

const mockEmail = (prompt: string): MockResult => {
  const company = pickField(prompt, 'COMPANY') ?? '贵公司';
  const contact = pickField(prompt, 'CONTACT') ?? '您好';
  const industry = pickField(prompt, 'INDUSTRY') ?? '所在行业';
  const country = pickField(prompt, 'COUNTRY') ?? '海外';
  const size = pickField(prompt, 'COMPANY_SIZE') ?? '中小型';
  const score = pickField(prompt, 'SCORE') ?? '70';
  const sender = pickField(prompt, 'SENDER_NAME') ?? 'Alex Chen';
  const senderCompany = pickField(prompt, 'SENDER_COMPANY') ?? 'DeepSeek Harness 销售自动化团队';
  const painPoint = pickField(prompt, 'PAIN_POINT') ?? '线索跟进效率低、回复率不稳定';

  const subject = `${company} × ${industry}：把 B2B 线索转化率提升 30% 的 3 步方案`;

  const body = `Hi ${contact}，

我是 ${senderCompany} 的 ${sender}。注意到 ${company} 是一家位于${country}的${industry}企业（团队规模 ${size}），
我猜你们在拓展海外客户时，也会遇到「${painPoint}」这类问题——这正是我们最近服务的 20+ 家${industry}客户的共同痛点。

我们的 B2B 销售 Agent 帮客户做到：
1) 线索导入后 5 分钟内完成自动评分与去重（当前线索评分：${score}/100）；
2) 基于客户行业/规模/地区生成个性化开发信，人工只需 1 次确认；
3) 自动识别客户回复意图（有意向 / 需资料 / 拒绝 / 中性）并推进状态，销售不再漏跟进。

参考结果：同类客户平均回复率从 4.1% 提升到 9.6%，首次响应时间从 26 小时缩短到 2 小时。

如果方便，我可以发一份 15 页的${industry}行业落地案例（含 ROI 测算）。
下周任意一天 30 分钟线上演示，你看哪个时间更合适？

Best regards,
${sender}
${senderCompany}
此邮件由 B2B Sales Agent（Mock 模式）自动生成，仅用于演示。`;

  const content = `SUBJECT: ${subject}\n---\n${body}`;
  return {
    content,
    usage: {
      prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
      completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
    },
  };
};

/* ------------------------------------------------------------------ */
/* 意图分类（Mock）                                                    */
/* ------------------------------------------------------------------ */

const mockClassify = (prompt: string): MockResult => {
  const replyText =
    pickBlock(prompt, 'REPLY_TEXT') ?? lastUserMessage([{ role: 'user', content: prompt }]);
  const { intent, hits } = ruleBasedIntent(replyText);
  const payload = {
    intent,
    confidence: confidenceFor(hits, replyText.length),
    sentiment: sentimentFor(intent),
    summary: summaryFor(intent, replyText),
    suggested_action: suggestedActionFor(intent),
    needs_human: intent === 'interested' || intent === 'rejected',
  };
  const content = JSON.stringify(payload, null, 2);
  return {
    content,
    usage: {
      prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
      completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
    },
  };
};

/* ------------------------------------------------------------------ */
/* 下一步建议（Mock）                                                  */
/* ------------------------------------------------------------------ */

const mockSuggestNextAction = (prompt: string): MockResult => {
  const status = pickField(prompt, 'STATUS') ?? 'contacted';
  const score = Number(pickField(prompt, 'SCORE') ?? '70');
  const intent = (pickField(prompt, 'INTENT') ?? 'neutral') as ReplyIntent;

  const map: Record<string, { action: string; priority: string; due_in_days: number }> = {
    new: { action: '补全客户信息并评分（enrich）', priority: 'high', due_in_days: 1 },
    enriched: { action: '生成个性化开发信', priority: 'high', due_in_days: 1 },
    email_drafted: { action: '人工确认后发送邮件', priority: 'high', due_in_days: 1 },
    contacted: { action: '3 个工作日内发送跟进邮件', priority: 'medium', due_in_days: 3 },
    replied: { action: '立即进行意图分类并推进状态', priority: 'high', due_in_days: 1 },
    interested: { action: '24 小时内发送会议邀约', priority: 'high', due_in_days: 1 },
    needs_info: { action: '整理技术规格与报价，48 小时内回复', priority: 'high', due_in_days: 2 },
    rejected: { action: '转入长期培育，90 天后唤醒', priority: 'low', due_in_days: 90 },
    neutral: { action: '7 天后发送行业案例跟进', priority: 'medium', due_in_days: 7 },
    meeting_booked: { action: '会议前 1 天发送议程与参会人清单', priority: 'high', due_in_days: 2 },
    closed: { action: '归档并请求客户推荐', priority: 'low', due_in_days: 30 },
  };

  const base = map[status] ?? { action: '跟进客户', priority: 'medium', due_in_days: 3 };
  const payload = {
    ...base,
    priority: score >= 75 ? 'high' : base.priority,
    reason: `当前状态 ${status}，线索评分 ${score}，最近意图 ${intent}`,
    playbook:
      intent === 'interested'
        ? ['发送会议邀约', '准备行业案例 PPT', '确认参会人角色']
        : ['发送跟进邮件', '补充价值证明', '设置 7 天后提醒'],
  };
  const content = JSON.stringify(payload, null, 2);
  return {
    content,
    usage: {
      prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
      completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
    },
  };
};

/**
 * Mock 入口：按 operation 路由到对应生成器。
 * 未知 operation 返回固定文本，保证不会阻塞流程。
 */
export const mockLlm = (operation: string, messages: LlmMessage[]): MockResult => {
  const prompt = messages.map((m) => m.content).join('\n\n');

  switch (operation) {
    case 'generate_email':
      return mockEmail(prompt);
    case 'classify_intent':
      return mockClassify(prompt);
    case 'suggest_next_action':
      return mockSuggestNextAction(prompt);
    default: {
      const content = `[mock-llm] operation=${operation} 未定义专用生成器，返回占位内容。`;
      return {
        content,
        usage: {
          prompt_tokens: Math.max(1, Math.ceil(prompt.length / 4)),
          completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
        },
      };
    }
  }
};

/**
 * 模拟客户回复（Phase 4 的 reply 服务与工作流使用）：
 * 按意图生成一封"像真人写的"客户回复，用于端到端演示。
 */
export const mockCustomerReply = (
  intent: ReplyIntent,
  context: { contactName?: string | null; companyName?: string | null; senderName?: string } = {},
): string => {
  const contact = context.contactName ?? '你好';
  const company = context.companyName ?? '我们';
  const sender = context.senderName ?? 'Alex';

  const replies: Record<ReplyIntent, string> = {
    interested: `${contact ? `${contact}，` : ''}你好 ${sender}，

感谢你的邮件，我们对这个方案很感兴趣。${company}今年计划把海外渠道的线索量提升一倍，你提到的自动评分和意图识别正好对得上我们的需求。

下周二或周三下午方便安排一次 30 分钟线上演示吗？我会拉上我们的销售运营负责人一起参加，会后我们可以进一步沟通合作细节。
另外能否先发一份同行业的落地案例和详细报价？

谢谢！`,
    needs_info: `Hi ${sender}，

收到你的邮件了。想先了解一下更详细的信息：
1. 你们的价格是怎么计算的？按账号还是按线索量？报价单能否发我一份？
2. 有没有制造业客户的案例和白皮书？
3. 支持私有化部署吗？我们这边合规要求比较高，需要看技术规格文档和安全认证报告。

麻烦把这些资料发我一份，我这边评估后再决定要不要安排演示。`,
    rejected: `${contact ? `${contact}，` : ''}你好，

谢谢你的邮件。不过我们目前没有这方面的预算，今年的预算已经用完了，而且已经在用一家供应商的方案，暂时不考虑更换。

请不要再给我发后续的跟进邮件了，如果以后有需要我会主动联系你们。

祝好。`,
    neutral: `收到，谢谢你的邮件。

我大概看了一下，这块不是我主要负责的方向，我已经转发给相关的同事了。近期比较忙，可能没时间深入聊，之后有机会再说。

祝好。`,
  };

  return replies[intent];
};

export default mockLlm;
