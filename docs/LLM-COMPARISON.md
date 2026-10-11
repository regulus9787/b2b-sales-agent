# LLM 模式对比：Mock 规则引擎 vs DeepSeek 真实模型

本文记录同一套代码在两种 LLM 模式下的**实测**差异，用于选型、成本评估与演示说明。

- 测试对象：客户 `#1 Shenzhen Nova Electronics Co., Ltd.`（消费电子制造 / CN / 500-1000 人 / 评分 82）
- 真实模型：`deepseek-flash`（DeepSeek V4.1-Flash），`LLM_THINKING=disabled`
- 测试时间：交付环境实测
- 复现命令：

```bash
# 同客户双模式横向对比（邮件生成 + 意图分类）
npx tsx scripts/compare-llm-modes.ts 1

# 26 条标注样本的准确率评估（走当前模式）
npm run eval:intent
```

---

## 1. 结论速览

| 维度 | Mock 模式 | 真实 DeepSeek（flash） | 倍数 |
|---|---|---|---|
| **邮件生成耗时** | 1 ms | 2510 ~ 2671 ms | ~2500× |
| **意图分类耗时** | 3 ms | 791 ~ 4428 ms | ~260 ~ 1400× |
| **邮件 tokens（输入/输出）** | 167 / 165 | 333 / 245 | 输出少 32%（prompt 更长） |
| **分类 tokens（输入/输出）** | 259 / 57 | 433 / 66 | 输入多 67% |
| **单客户一次「邮件+分类」成本** | $0 | **$0.0006**（约 0.4 分人民币） | — |
| **完整工作流（3 次 LLM 调用）成本** | $0 | **$0.0008**（实测 $0.0008469） | — |
| **邮件质量** | 模板化，占位符式个性化 | 引用官网产品线，痛点具体，案例可信 | — |
| **分类置信度** | 0.84 | **0.97** | — |
| **分类摘要质量** | 截断原文前 40 字 | 真正的语义总结 | — |
| **建议动作** | 固定话术 | 结合回复里的具体时间 | — |
| **26 条样本准确率** | **92.31%**（规则分类器） | 需自行跑 `npm run eval:intent` 实测 | — |

**一句话选型建议**：

- **开发 / CI / 演示 / 无网络环境** → Mock 模式（零成本、毫秒级、确定性输出，26 条样本 92.31% 准确率足够验证链路）
- **生产 / 追求回复率** → 真实模型（成本极低：一次完整工作流不到 1 分钱，质量差距显著）

---

## 2. 邮件生成对比（同一客户、同一 Prompt 模板 v1.2.0）

### 2.1 Mock 模式输出

```
主题行: SUBJECT: Shenzhen Nova Electronics Co., Ltd. × 消费电子制造：把 B2B 线索转化率提升 30% 的 3 步方案
耗时: 1ms | tokens: 167/165 | 成本: $0
```

```
Hi Kevin Zhang，

我是 B2B Sales Agent Demo Team 的 Alex Chen。注意到 Shenzhen Nova Electronics Co., Ltd. 是一家位于CN的消费电子制造企业（团队规模 500-1000），
我猜你们在拓展海外客户时，也会遇到「海外渠道线索分散、展会名单转化率低、跟单周期长」这类问题——这正是我们最近服务的 20+ 家消费电子制造客户的共同痛点。

我们的 B2B 销售 Agent 帮客户做到：
1) 线索导入后 5 分钟内完成自动评分与去重（当前线索评分：82/100）；
2) 基于客户行业/规模/地区生成个性化开发信，人工只需 1 次确认；
3) 自动识别客户回复意图（有意向 / 需资料 / 拒绝 / 中性）并推进状态，销售不再漏跟进。

参考结果：同类客户平均回复率从 4.1% 提升到 9.6%，首次响应时间从 26 小时缩短到 2 小时。

如果方便，我可以发一份 15 页的消费电子制造行业落地案例（含 ROI 测算）。
下周任意一天 30 分钟线上演示，你看哪个时间更合适？

Best regards,
Alex Chen
B2B Sales Agent Demo Team
此邮件由 B2B Sales Agent（Mock 模式）自动生成，仅用于演示。
```

**特征**：结构完整（痛点 → 3 条价值 → 社会证明 → CTA），能正确插入客户名/公司名/行业/规模/评分，但**句式固定**，且结尾带 Mock 免责声明。

### 2.2 真实 DeepSeek 输出（同一 Prompt）

```
主题行: SUBJECT: 为 Nova Electronics 提升海外渠道线索转化率
耗时: 2510ms | tokens: 333/245 | 成本: $0.0003939
```

```
Kevin，您好：

注意到贵司官网展示了多款智能穿戴与音频产品，且团队规模在500-1000人，相信海外渠道拓展是当前重点。结合您提到的"线索分散、展会名单转化低、跟单周期长"，我们理解消费电子制造出海的典型瓶颈。

我们帮助B2B制造企业解决三个具体问题：
1. 线索自动评分与去重：将展会、LinkedIn、官网表单统一清洗，按ICP匹配度排序，减少无效跟进。
2. 个性化开发信生成：基于客户官网与产品动态，自动产出高相关邮件，提升回复率。
3. 回复意图自动分类与状态推进：识别询盘、拒绝、转介绍等意图，自动更新CRM阶段，缩短跟单周期。

某深圳消费电子ODM客户使用后，展会名单有效转化率提升2.3倍，首响时间从48小时降至4小时。

如果您愿意，我可以发送一份针对 Nova 产品线的线索评分模板，您只需回复"模板"即可。期待交流。
```

**质量差异（肉眼可见）**：

| 对比点 | Mock | DeepSeek |
|---|---|---|
| 称呼 | `Hi Kevin Zhang`（把姓名整串当地名） | `Kevin，您好`（正确识别名字） |
| 个性化锚点 | 公司名 + 行业 + 规模（字段填充） | **官网上的具体产品线**（智能穿戴、音频） |
| 痛点表述 | 行业库预设文本 | 结合客户规模重新组织，更贴合场景 |
| 价值主张 | 通用三条 | 每条都带交付物（ICP 匹配度排序 / 高相关邮件 / CRM 阶段） |
| 案例 | 通用数字（4.1% → 9.6%） | 更具体的同行画像（深圳 ODM、2.3 倍） |
| CTA | 请求演示 | **只需回复"模板"**（门槛更低） |
| 签名 | 带 Mock 免责声明 | 干净的专业签名 |

> 注：真实模型多次运行会有措辞变化（同一 Prompt 下主题行分别为「给Nova Electronics的海外渠道线索管理方案」「为 Nova Electronics 提升海外渠道线索转化率」），这是正常现象；Mock 模式则完全确定性，便于测试断言。

---

## 3. 意图分类对比（同一段客户回复）

输入回复（`interested` 类型模拟回复）：

```
Kevin Zhang，你好 Alex Chen，

感谢你的邮件，我们对这个方案很感兴趣。Shenzhen Nova Electronics Co., Ltd.今年计划把
海外渠道的线索量提升一倍，你提到的自动评分和意图识别正好对得上我们的需求。

下周二或周三下午方便安排一次 30 分钟线上演示吗？我会拉上我们的销售运营负责人一起参加，
会后我们可以进一步沟通合作细节。
另外能否先发一份同行业的落地案例和详细报价？

谢谢！
```

| 维度 | Mock（规则分类器） | DeepSeek flash |
|---|---|---|
| 意图（intent） | `interested` ✅ | `interested` ✅ |
| 置信度 | 0.84 | **0.97** |
| 情感 | positive | positive |
| 耗时 | **3 ms** | 791 ~ 4428 ms |
| tokens | 259 / 57 | 433 / 66 |
| 成本 | $0 | $0.0002091 |
| 摘要 | "客户表达明确兴趣，建议尽快推进会议：Kevin Zhang，你好 Alex Chen， 感谢你的邮件，我们对这个方案…"（**截断原文**） | "客户对方案感兴趣，邀约下周演示并索要案例报价"（**语义总结**） |
| 建议动作 | "24 小时内发送会议邀约（附 3 个可选时段）"（固定） | "确认演示时间，提前发送案例与报价"（**结合上下文**） |
| needs_human | true | true |

**差异本质**：Mock 的摘要与建议来自固定模板 + 关键词命中，因此"看起来对"但信息量低；真实模型能压缩出可读摘要并给出带上下文的具体动作。对销售来说，后者直接可用于 CRM 任务描述。

### 规则分类器的准确率基线

```bash
npm run eval:intent
# 总准确率  : 92.31%  (24/26)
#   interested   85.71%  (6/7)
#   needs_info   85.71%  (6/7)
#   rejected    100.00%  (6/6)
#   neutral     100.00%  (6/6)
```

这是 26 条中英混排标注样本上的实测值。配置真实 Key 后跑同一条命令，可得到真实模型在同一数据集上的准确率，直接对比：

```bash
# Windows cmd
set EVAL_MIN_ACCURACY=85
npm run eval:intent
```

---

## 4. 成本实测

### 4.1 单次完整工作流（`full_cycle`，3 次 LLM 调用）

实测 run `a6e050e0-...`：

| 操作 | tokens（输入/输出） | 耗时 | 成本（USD） |
|---|---|---|---|
| `generate_email` | 333 / 301 | 217 ms | $0.0004611 |
| `classify_intent` | 430 / 73 | 104 ms | $0.0002166 |
| `suggest_next_action` | 180 / 96 | 66 ms | $0.0001692 |
| **合计** | **943 / 470** | **4042 ms（含 HTTP 与写库）** | **$0.0008469** |

### 4.2 换算成业务量级

| 业务量 | 预估成本（deepseek-flash，峰值价） | 备注 |
|---|---|---|
| 1 个客户完整链路 | 约 $0.0008 | 邮件 + 分类 + 建议 |
| 100 个客户 | 约 $0.08 | 约 0.6 元人民币 |
| 1000 个客户 | 约 $0.80 | 约 6 元人民币 |
| 26 条样本评估 | 约 $0.006 | 约 4 分人民币 |

> 单价来源 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)：
> `deepseek-flash` 峰值 $0.3/1M 输入、$1.2/1M 输出（低谷半价）。
> 项目内 [pricing.ts](../src/services/pricing.ts) 统一按**峰值价**估算，因此看板显示的金额是偏保守的上限。
> 若改用 `deepseek-v4-pro`，成本约为 flash 的 4.4 倍。

### 4.3 省钱的两个开关

1. **`LLM_THINKING=disabled`（默认）**：DeepSeek 的思考模式默认开启，会先输出思维链 `reasoning_content` 再给正文，而**思维链按输出 token 计费**。本项目只消费 `content` 字段，因此默认关闭——仅这一项就避免了数倍的输出 token 浪费。
2. **Prompt 精简**：分类任务的 prompt 已控制在 430 tokens 左右；`generate_email` 的行业痛点/价值主张来自本地库而非塞进 prompt。

---

## 5. 工程实现差异（同一套代码如何支持两种模式）

| 环节 | 实现 | 说明 |
|---|---|---|
| 模式判定 | `src/config.ts` → `isMockMode = !LLM_API_KEY \|\| LLM_PROVIDER === 'mock'` | 空 Key 自动 Mock，无需改代码 |
| 单一出口 | 所有调用走 `services/llm.ts` 的 `callLlmRaw` / `callLlmJson` | 路由层零 `fetch` |
| Mock 实现 | `services/llm-mock.ts` → `mockLlm(operation, messages)` | 按 operation 路由到邮件/分类/建议生成器 |
| 强制覆盖 | `LlmCallOptions.mock` | 测试与对比脚本可在同一进程内跑两种模式 |
| 调用留痕 | 每次调用写 `llm_calls`（model、tokens、latency_ms、cost_usd、status、mock） | 前端看板区分"其中 N 次为 Mock 调用" |
| 数据标记 | `email_messages.mock`、`replies.mock` | 可追溯每封邮件/每次分类由谁生成 |
| 降级策略 | 分类失败 → 规则兜底 + `fallback: true` + `llm_calls.status='error'` | 真实模型故障不阻断业务 |

---

## 6. 复现步骤

```bash
# 1) 配置真实 Key（.env）
LLM_API_KEY=sk-xxxx
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-flash
LLM_THINKING=disabled

# 2) 重启后端（.env 只在启动时读取）
taskkill /F /IM node.exe
npm run dev

# 3) 确认模式
curl http://localhost:3000/health          # 期望 "mode": "live"

# 4) 双模式横向对比（会真实调用 2 次 LLM，成本约 $0.0006）
npx tsx scripts/compare-llm-modes.ts 1

# 5) 准确率评估（26 条样本，成本约 $0.006）
npm run eval:intent

# 6) 切回 Mock：把 LLM_API_KEY 清空后重启即可
```

---

## 7. 切到真实模式后必须注意的两个坑（已修复）

### 7.1 测试会自动改用真实 API（已修）

**现象**：`.env` 里配好真实 Key 后，`npm test` 从 ~6 秒变成 **174 秒**，并且 **11 个测试失败**——因为测试代码读的是同一份 `config`，于是真的去调 DeepSeek（断言"模型名应为 mock"自然失败，还白花钱）。

**根因**：`src/config.ts` 的 `isMockMode` 只看环境变量，测试进程继承了 `.env` 的真实 Key。

**修复**：[`tests/setup.ts`](../tests/setup.ts) 在每个测试文件启动时强制 Mock 模式；[`vitest.config.ts`](../vitest.config.ts) 同时用 `env` 清空 `LLM_API_KEY`：

```ts
// vitest.config.ts
setupFiles: ['./tests/setup.ts'],
env: { LLM_API_KEY: '', LLM_PROVIDER: 'mock', LOG_LEVEL: 'silent' },
```

需要验证真实调用链路的测试，一律用 per-call 覆盖（见 `tests/unit/llm.test.ts` 的 `liveOptions`）：

```ts
callLlmRaw({ operation: 'classify_intent', fetchImpl, ...liveOptions }) // mock: false, apiKey: 'test-key'
// 或
classifyReplyText(input, { db, mock: false })  // 评估/对比脚本用这个
```

**修复后**：152 个测试全过、耗时回到 5.5 秒、零真实调用。**即使 `.env` 配置了真实 Key，`npm test` 也不会花钱。**

### 7.2 `response_format: json_object` 要求 prompt 含 "json"（已修）

**现象**：真实模式下直接调用 `callLlmJson` 报 400：

```
Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'.
```

**根因**：`callLlmJson` 会给请求加 `response_format: { type: 'json_object' }`，但把"prompt 里必须出现 json 字样"这个约束留给了调用方。DeepSeek / OpenAI 都会做这个前置校验。

> 生产链路未受影响：`classifyReplyText` 走的是 `callLlmRaw` + `extractJsonObject` 手动解析，且分类 Prompt 模板里本身含 "JSON" 字样。出问题的是这个导出函数在真实模式下的可用性。

**修复**：[`src/services/llm.ts`](../src/services/llm.ts) 新增 `ensureJsonInstruction()`，在 messages 中没有 "json" 时自动补一条 system 指令：

```ts
export const ensureJsonInstruction = (messages: LlmMessage[]): LlmMessage[] => {
  const hasJson = messages.some((message) => /json/i.test(message.content));
  if (hasJson) return messages;
  return [
    { role: 'system', content: 'You must respond with a single valid JSON object only, ...' },
    ...messages,
  ];
};
```

并补了两个回归测试（其中一个是模拟真实 API 校验行为的本地 mock fetch，确认不再触发 400）。

---

## 8. 未在本文验证的内容

- **真实模型的 26 条样本准确率**：需要消耗额度执行 `npm run eval:intent`，本文只记录了 Mock 规则分类器的 92.31% 基线。
- **`deepseek-v4-pro` 的对比数据**：未实测，价格表已支持（改 `LLM_MODEL` 后看板会自动按新单价计算）。
- **思考模式开启后的质量/成本差异**：未实测，可通过 `LLM_THINKING=enabled` 做 A/B。
- **英文邮件效果**：本次 Prompt 指定"中文为主"，未测纯英文开发信场景。
