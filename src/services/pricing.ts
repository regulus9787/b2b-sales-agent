/**
 * 单价表（可按需扩展）。匹配规则：先精确匹配，再前缀匹配。
 *
 * DeepSeek 价格来源：https://api-docs.deepseek.com/quick_start/pricing
 * 官方已改为「峰谷计价」，且旧模型名 deepseek-chat / deepseek-reasoner 于 2026-07-24 停用。
 * 这里的估算统一采用**峰值价**（更保守，不会低报成本）：
 *   高峰时段 = UTC 周一至周五 01:00-04:00 与 06:00-10:00（不含中国法定节假日），其余为低谷（半价）。
 * 模型实际单价为每 1M tokens，这里换算成每 1K tokens。
 */
export interface ModelPricing {
  /** 每 1K prompt token 的价格（USD） */
  inputPer1k: number;
  /** 每 1K completion token 的价格（USD） */
  outputPer1k: number;
  currency: 'USD';
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ---------- DeepSeek（当前在售模型）----------
  // deepseek-flash 峰值：输入 $0.3/1M、输出 $1.2/1M（低谷为半价 $0.15 / $0.6）
  'deepseek-flash': { inputPer1k: 0.0003, outputPer1k: 0.0012, currency: 'USD' },
  // deepseek-v4-pro 峰值：输入 $1.32/1M、输出 $3.96/1M（低谷为半价 $0.66 / $1.98）
  'deepseek-v4-pro': { inputPer1k: 0.00132, outputPer1k: 0.00396, currency: 'USD' },
  // 过渡期兼容名（官方声明已退役，请求会被路由到 V4.1-Flash 并按 Flash 计费）
  'deepseek-v4-flash': { inputPer1k: 0.0003, outputPer1k: 0.0012, currency: 'USD' },
  'deepseek-v4-flash-vision-exp': { inputPer1k: 0.0003, outputPer1k: 0.0012, currency: 'USD' },
  // 已停用模型名（2026-07-24 起不再服务）：保留单价仅为兼容历史数据展示
  'deepseek-chat': { inputPer1k: 0.00027, outputPer1k: 0.0011, currency: 'USD' },
  'deepseek-reasoner': { inputPer1k: 0.00055, outputPer1k: 0.00219, currency: 'USD' },

  // ---------- OpenAI ----------
  'gpt-4o-mini': { inputPer1k: 0.00015, outputPer1k: 0.0006, currency: 'USD' },
  'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.01, currency: 'USD' },
  'gpt-4.1-mini': { inputPer1k: 0.0004, outputPer1k: 0.0016, currency: 'USD' },

  // ---------- 豆包 / 火山方舟 ----------
  'doubao-pro-32k': { inputPer1k: 0.00011, outputPer1k: 0.00028, currency: 'USD' },
  'doubao-lite-32k': { inputPer1k: 0.00005, outputPer1k: 0.00011, currency: 'USD' },

  // Mock 模式：不产生真实费用
  mock: { inputPer1k: 0, outputPer1k: 0, currency: 'USD' },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1k: 0, outputPer1k: 0, currency: 'USD' };

export const resolvePricing = (model: string): ModelPricing => {
  const key = model.trim().toLowerCase();
  const exact = MODEL_PRICING[key];
  if (exact) return exact;

  // 前缀匹配，例如 deepseek-chat-0324 → deepseek-chat
  const prefixMatch = Object.keys(MODEL_PRICING).find((candidate) => key.startsWith(candidate));
  return prefixMatch ? (MODEL_PRICING[prefixMatch] as ModelPricing) : DEFAULT_PRICING;
};

/**
 * 估算成本（USD）。
 * 例：deepseek-chat 1000 prompt + 500 completion
 *   = 0.00027 * 1 + 0.0011 * 0.5 = 0.00082 USD
 */
export const estimateCostUsd = (
  model: string,
  promptTokens: number,
  completionTokens: number,
): number => {
  const pricing = resolvePricing(model);
  const cost =
    (promptTokens / 1000) * pricing.inputPer1k + (completionTokens / 1000) * pricing.outputPer1k;
  return Number(cost.toFixed(8));
};

/** 粗略 token 估算（无 usage 时的兜底）：中文 ≈ 1.6 字符/token，英文 ≈ 4 字符/token */
export const estimateTokensFromText = (text: string): number => {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.max(1, Math.ceil(cjk / 1.6 + rest / 4));
};
