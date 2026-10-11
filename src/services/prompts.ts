/**
 * Prompt 模板管理（版本化）—— AGENTS.md 第 5 节要求
 *
 * 约定：
 *  - 每个模板有唯一 id 与 version（语义化），版本变更必须新建模板而不是原地修改；
 *  - 模板用 {{placeholder}} 插值，缺失字段保留空字符串；
 *  - 结构化字段以 KEY: value 形式输出，Mock LLM 与真实 LLM 共用同一份上下文。
 */
import { z } from 'zod';
import type { CustomerStatus } from '../core/status';

export const PROMPT_VERSIONS = {
  generateEmail: 'v1.2.0',
  classifyIntent: 'v1.3.0',
  suggestNextAction: 'v1.1.0',
  scoreLead: 'v1.0.0',
} as const;

export type PromptId = keyof typeof PROMPT_VERSIONS;

/** 严重度：需要人工介入的意图 */
export const HUMAN_REVIEW_INTENTS = ['interested', 'rejected'] as const;

export interface PromptTemplate {
  id: PromptId;
  version: string;
  description: string;
  system: string;
  user: string;
}

export const PROMPTS: Record<PromptId, PromptTemplate> = {
  generateEmail: {
    id: 'generateEmail',
    version: PROMPT_VERSIONS.generateEmail,
    description: '根据客户画像生成个性化 B2B 开发信（含主题行）。',
    system: `你是一名资深的 B2B 海外销售开发（SDR）专家，擅长写高回复率的冷启动开发信。
写作要求：
1. 邮件正文使用客户所在行业的专业语言，禁止空洞套话；
2. 结构：个性化开场（引用客户信息）→ 痛点共鸣 → 3 条价值主张 → 社会证明 → 明确且低门槛的 CTA；
3. 长度控制在 180-260 个英文单词或等量中文，段落短，便于手机阅读；
4. 必须输出一行主题，格式严格要求为：第一行 "SUBJECT: <主题>"，第二行 "---"，之后是正文；
5. 不要输出任何解释、Markdown 代码块或多余前后缀。`,
    user: `请为以下客户生成一封个性化开发信。

COMPANY: {{company_name}}
CONTACT: {{contact_name}}
INDUSTRY: {{industry}}
COUNTRY: {{country}}
COMPANY_SIZE: {{company_size}}
WEBSITE: {{website}}
SCORE: {{score}}
PAIN_POINT: {{pain_point}}
VALUE_PROP: {{value_prop}}
SENDER_NAME: {{sender_name}}
SENDER_COMPANY: {{sender_company}}
LANGUAGE: {{language}}

输出格式（严格遵守）：
SUBJECT: <邮件主题>
---
<邮件正文>`,
  },

  classifyIntent: {
    id: 'classifyIntent',
    version: PROMPT_VERSIONS.classifyIntent,
    description: '把客户回复分类为 interested / needs_info / rejected / neutral 四类意图。',
    system: `你是一名 B2B 销售回复意图分类器。你只输出一个 JSON 对象，不输出任何解释、Markdown 或代码块。

意图定义（必须四选一）：
- interested：明确表达兴趣、希望进一步沟通/演示/报价、愿意安排会议。
- needs_info：要求补充资料、询问价格/规格/合规/案例，尚未表态是否合作。
- rejected：明确拒绝、无预算、已有供应商、要求停止联系、退订。
- neutral：礼貌性收到、转交他人、暂时没空、含糊或无法判断。

判断优先级：rejected > interested > needs_info > neutral（当多条线索冲突时按此优先级）。

JSON 字段要求：
{
  "intent": "interested" | "needs_info" | "rejected" | "neutral",
  "confidence": 0.0-1.0 的数字,
  "sentiment": "positive" | "neutral" | "negative",
  "summary": "一句话中文摘要（不超过 50 字）",
  "suggested_action": "给销售的下一步动作建议（中文，不超过 30 字）",
  "needs_human": true | false
}`,
    user: `请对下面这封客户回复做意图分类。

COMPANY: {{company_name}}
CONTACT: {{contact_name}}
INDUSTRY: {{industry}}
CUSTOMER_STATUS: {{status}}
ORIGINAL_SUBJECT: {{email_subject}}
REPLY_TEXT:
{{reply_text}}

只输出 JSON。`,
  },

  suggestNextAction: {
    id: 'suggestNextAction',
    version: PROMPT_VERSIONS.suggestNextAction,
    description: '基于客户当前状态与最近意图，给出下一步最佳动作。',
    system: `你是 B2B 销售流程顾问。只输出一个 JSON 对象，不要任何解释或代码块。
JSON 字段：
{
  "action": "下一步动作（中文，不超过 40 字）",
  "priority": "high" | "medium" | "low",
  "due_in_days": 数字,
  "reason": "给出该建议的原因（中文，不超过 50 字）",
  "playbook": ["具体执行步骤", "…"]  // 2-3 条
}`,
    user: `请给出下一步最佳动作建议。

COMPANY: {{company_name}}
STATUS: {{status}}
SCORE: {{score}}
INTENT: {{intent}}
LAST_EVENT: {{last_event}}

只输出 JSON。`,
  },

  scoreLead: {
    id: 'scoreLead',
    version: PROMPT_VERSIONS.scoreLead,
    description: '线索评分（本地规则为主，LLM 可做增强解释）。',
    system: `你是 B2B 线索评分助手。只输出一个 JSON 对象：
{ "score": 0-100 的整数, "reason": "评分理由（中文，不超过 60 字）", "signals": ["命中的信号", "…"] }`,
    user: `请为该线索评分。

COMPANY: {{company_name}}
INDUSTRY: {{industry}}
COUNTRY: {{country}}
COMPANY_SIZE: {{company_size}}
WEBSITE: {{website}}
NOTES: {{notes}}
SOURCE: {{source}}

只输出 JSON。`,
  },
};

/** 极简模板渲染：{{key}} → value；缺失 key 渲染为空字符串 */
export const renderTemplate = (template: string, vars: Record<string, unknown> | object): string =>
  template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = (vars as Record<string, unknown>)[key];
    if (value === undefined || value === null) return '';
    return String(value);
  });

export const getPrompt = (id: PromptId): PromptTemplate => PROMPTS[id];

export interface EmailPromptVars {
  company_name: string;
  contact_name?: string | null;
  industry?: string | null;
  country?: string | null;
  company_size?: string | null;
  website?: string | null;
  score: number;
  pain_point?: string | null;
  value_prop?: string | null;
  sender_name?: string;
  sender_company?: string;
  language?: string;
}

export const SENDER_DEFAULTS = {
  name: 'Alex Chen',
  company: 'B2B Sales Agent Demo Team',
} as const;

/** 行业痛点库：让开发信"看起来真的是懂这行" */
export const INDUSTRY_PAIN_POINTS: Record<string, string> = {
  消费电子制造: '海外渠道线索分散、展会名单转化率低、跟单周期长',
  'SaaS 软件': 'PLG 转 SLG 时线索质量参差、销售人均跟进量不足',
  精密机械: '长决策链下缺少持续触达、技术资料交付不及时',
  跨境物流: '询价响应慢导致丢单、客户生命周期价值未挖掘',
  数据服务: '获客成本高、销售线索与产品使用数据割裂',
  生物医药: '合规沟通门槛高、关键决策人难以触达',
  电子元器件: '料号级需求匹配困难、样品跟进繁琐',
  纺织制造: '海外中小客户询盘多但转化低、报价效率低',
  金融科技: '合规审查周期长、需要高质量案例与安全说明',
  新能源: '项目制销售周期长、需要多角色协同推进',
};

export const INDUSTRY_VALUE_PROPS: Record<string, string> = {
  default: '线索自动评分与去重、个性化开发信生成、回复意图自动分类与状态推进',
};

export const buildEmailMessages = (
  vars: EmailPromptVars,
): { system: string; user: string; version: string } => {
  const prompt = getPrompt('generateEmail');
  const industry = vars.industry ?? '';
  const painPoint =
    vars.pain_point ?? INDUSTRY_PAIN_POINTS[industry] ?? '线索跟进效率低、回复率不稳定';
  const valueProp =
    vars.value_prop ?? INDUSTRY_VALUE_PROPS[industry] ?? INDUSTRY_VALUE_PROPS.default ?? '';

  return {
    version: prompt.version,
    system: prompt.system,
    user: renderTemplate(prompt.user, {
      ...vars,
      pain_point: painPoint,
      value_prop: valueProp,
      sender_name: vars.sender_name ?? SENDER_DEFAULTS.name,
      sender_company: vars.sender_company ?? SENDER_DEFAULTS.company,
      language: vars.language ?? '中文为主，保留英文专业术语',
    }),
  };
};

export interface ClassifyPromptVars {
  company_name: string;
  contact_name?: string | null;
  industry?: string | null;
  status: CustomerStatus | string;
  email_subject?: string | null;
  reply_text: string;
}

export const buildClassifyMessages = (
  vars: ClassifyPromptVars,
): { system: string; user: string; version: string } => {
  const prompt = getPrompt('classifyIntent');
  return {
    version: prompt.version,
    system: prompt.system,
    user: renderTemplate(prompt.user, vars),
  };
};

export interface NextActionPromptVars {
  company_name: string;
  status: CustomerStatus | string;
  score: number;
  intent?: string | null;
  last_event?: string | null;
}

export const buildNextActionMessages = (
  vars: NextActionPromptVars,
): { system: string; user: string; version: string } => {
  const prompt = getPrompt('suggestNextAction');
  return {
    version: prompt.version,
    system: prompt.system,
    user: renderTemplate(prompt.user, { intent: 'unknown', last_event: '-', ...vars }),
  };
};

/* ---------------- LLM 输出的 Zod 校验 schema ---------------- */

export const intentClassificationSchema = z.object({
  intent: z.enum(['interested', 'needs_info', 'rejected', 'neutral']),
  confidence: z.number().min(0).max(1),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  summary: z.string().min(1).max(300),
  suggested_action: z.string().min(1).max(200),
  needs_human: z.boolean(),
});

export type IntentClassification = z.infer<typeof intentClassificationSchema>;

export const nextActionSchema = z.object({
  action: z.string().min(1).max(200),
  priority: z.enum(['high', 'medium', 'low']),
  due_in_days: z.number().int().min(0).max(365),
  reason: z.string().min(1).max(300),
  playbook: z.array(z.string().min(1)).min(1).max(6),
});

export type NextAction = z.infer<typeof nextActionSchema>;

export const emailDraftSchema = z.object({
  subject: z.string().min(3).max(200),
  body: z.string().min(20),
});

export type EmailDraft = z.infer<typeof emailDraftSchema>;

/**
 * 解析 LLM 邮件输出：要求 "SUBJECT: xxx\n---\nbody"。
 * 若格式不符，降级为「首行作主题、其余作正文」。
 */
export const parseEmailDraft = (content: string): EmailDraft => {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  const match = normalized.match(/^\s*SUBJECT\s*[:：]\s*(.+?)\s*\n-{3,}\s*\n([\s\S]+)$/i);
  if (match?.[1] && match[2]) {
    return emailDraftSchema.parse({ subject: match[1].trim(), body: match[2].trim() });
  }

  const lines = normalized.split('\n');
  const firstLine = (lines[0] ?? '').replace(/^\s*SUBJECT\s*[:：]\s*/i, '').trim();
  const rest = lines
    .slice(1)
    .join('\n')
    .replace(/^-{3,}\s*$/m, '')
    .trim();
  const subject = firstLine.length >= 3 ? firstLine : '关于提升 B2B 线索转化率的合作建议';
  const body = rest.length >= 20 ? rest : normalized;

  return emailDraftSchema.parse({ subject, body });
};

export default PROMPTS;
