# B2B Sales Agent —— API 文档

- **基础地址**：http://localhost:3000
- **在线文档（Swagger UI）**：http://localhost:3000/docs
- **OpenAPI 规范**：http://localhost:3000/docs/openapi.json ｜ 仓库文件：`docs/openapi.json`（由 `npm run openapi` 生成）
- **Postman 集合**：`postman/collection.json`

---

## 1. 约定

### 1.1 统一响应信封

成功（HTTP 200 / 201）：

```json
{
  "success": true,
  "data": { },
  "meta": { "request_id": "5dbf011b-8eda-4589-848d-b4b3abf6ec15" }
}
```

失败：

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "请求query校验失败",
    "details": {
      "source": "query",
      "issues": [{ "path": "page", "message": "Number must be greater than or equal to 1", "code": "too_small" }]
    }
  },
  "meta": { "request_id": "e6965a4e-4b85-41c8-ac68-32baf6f03574" }
}
```

### 1.2 request_id

每个请求都会生成 `request_id`（`crypto.randomUUID()`）：

- 响应体 `meta.request_id`
- 响应头 `x-request-id`
- 日志字段 `request_id`
- 落库字段：`events.request_id`、`agent_runs.request_id`

若客户端主动传入 `x-request-id`，服务端会透传使用（便于链路追踪与前端埋点）。

### 1.3 错误码

| 错误码 | HTTP | 触发场景 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod 校验失败（body / query / params） |
| `CUSTOMER_NOT_FOUND` | 404 | `customer_id` 不存在 |
| `LEAD_NOT_FOUND` | 404 | `lead_id` 不存在 |
| `AGENT_RUN_NOT_FOUND` | 404 | `run_id` 不存在 |
| `NOT_FOUND` | 404 | 接口路径不存在 |
| `INVALID_STATUS_TRANSITION` | 409 | 状态机拒绝跳转（`details.from_status` / `details.to_status`） |
| `LLM_TIMEOUT` | 504 | LLM 调用超时（`LLM_TIMEOUT_MS`） |
| `LLM_RATE_LIMIT` | 429 | LLM 返回 429（`details.retry_after_ms`） |
| `LLM_INVALID_OUTPUT` | 502 | LLM 输出无法通过 Zod 校验 |
| `LLM_ERROR` | 502 | LLM 其他错误 / 网络错误 |
| `INTERNAL_ERROR` | 500 | 未预期异常 |

### 1.4 分页

分页接口统一支持 `page`（默认 1）、`pageSize`（默认 20，最大 100），返回：

```json
{
  "items": [],
  "pagination": { "page": 1, "pageSize": 20, "total": 42, "totalPages": 3 }
}
```

---

## 2. 接口详情

### 2.1 GET /health

健康检查：数据库连通性、schema 版本、LLM 模式、已注册 Agent 工具。

```bash
curl http://localhost:3000/health
```

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "uptime_s": 7.11,
    "version": "1.0.0",
    "env": "development",
    "timestamp": "2026-01-01T09:26:01.050Z",
    "database": "ok",
    "schema_version": 2,
    "llm": {
      "mode": "mock",
      "provider": "mock",
      "model": "mock",
      "base_url": null,
      "timeout_ms": 30000,
      "max_retries": 3
    },
    "agent_tools": ["import_leads", "score_lead", "generate_email", "classify_reply", "suggest_next_action"]
  },
  "meta": { "request_id": "..." }
}
```

---

### 2.2 GET /api/customers

客户列表：分页 / 状态过滤 / 搜索 / 排序。

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `page` | integer ≥1 | 否 | 默认 1 |
| `pageSize` | integer 1-100 | 否 | 默认 20 |
| `status` | enum | 否 | 11 个状态之一：`new`/`enriched`/`email_drafted`/`contacted`/`replied`/`interested`/`needs_info`/`rejected`/`neutral`/`meeting_booked`/`closed` |
| `search` | string | 否 | 模糊匹配公司名 / 邮箱 / 联系人 / 行业 |
| `minScore` | integer 0-100 | 否 | 最低线索评分 |
| `sortBy` | enum | 否 | `created_at`（默认）/ `updated_at` / `score` / `company_name` |
| `sortOrder` | enum | 否 | `asc` / `desc`（默认） |

```bash
curl "http://localhost:3000/api/customers?page=1&pageSize=5&status=interested&search=nova"
```

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 6,
        "company_name": "Beijing MedCore Biotech",
        "contact_name": "Dr. Wang Lei",
        "email": "wanglei@medcore-bio.example.com",
        "phone": "+86-10-6677-8899",
        "website": "https://medcore-bio.example.com",
        "industry": "生物医药",
        "country": "CN",
        "company_size": "500-1000",
        "status": "interested",
        "score": 88,
        "source": "seed",
        "notes": "明确表达合作意向，等待会议安排",
        "last_contacted_at": null,
        "last_replied_at": null,
        "created_at": "2026-01-01T09:20:00.000Z",
        "updated_at": "2026-01-01T09:20:00.000Z",
        "emails_count": 0,
        "replies_count": 0,
        "last_intent": null,
        "last_event_at": "2026-01-01T09:20:00.000Z"
      }
    ],
    "pagination": { "page": 1, "pageSize": 5, "total": 1, "totalPages": 1 }
  },
  "meta": { "request_id": "..." }
}
```

---

### 2.3 GET /api/customers/status-machine

返回状态机定义，供前端渲染与文档生成。

```bash
curl http://localhost:3000/api/customers/status-machine
```

```json
{
  "success": true,
  "data": {
    "statuses": ["new", "enriched", "email_drafted", "contacted", "replied", "interested", "needs_info", "rejected", "neutral", "meeting_booked", "closed"],
    "transitions": {
      "new": ["enriched"],
      "enriched": ["email_drafted"],
      "email_drafted": ["contacted", "email_drafted"],
      "contacted": ["replied", "contacted"],
      "replied": ["interested", "needs_info", "rejected", "neutral", "replied"],
      "interested": ["meeting_booked", "closed", "interested", "needs_info"],
      "needs_info": ["contacted", "interested", "rejected", "neutral", "closed", "needs_info"],
      "rejected": ["closed", "rejected"],
      "neutral": ["contacted", "interested", "meeting_booked", "closed", "neutral"],
      "meeting_booked": ["closed", "meeting_booked"],
      "closed": ["closed"]
    },
    "terminal": ["closed", "rejected"],
    "labels": { "new": "新线索", "interested": "有意向", "closed": "已关闭" }
  },
  "meta": { "request_id": "..." }
}
```

---

### 2.4 GET /api/customers/{id}

客户详情：客户信息 + 邮件记录 + 回复记录 + 状态时间线 + 全部事件 + LLM 调用明细 + 下一步建议 + 允许的跳转。

```bash
curl http://localhost:3000/api/customers/1
```

关键字段：

| 字段 | 说明 |
|---|---|
| `customer` | 客户汇总（含 `emails_count` / `replies_count` / `last_intent`） |
| `emails` | 邮件记录（含 `model` / `prompt_tokens` / `completion_tokens` / `latency_ms` / `mock`） |
| `replies` | 客户回复（含 `intent` / `confidence` / `summary` / `suggested_action` / `from_status` / `to_status`） |
| `timeline` | 只含 `status_changed` 事件，按时间正序 |
| `events` | 全部事件（含 `payload`） |
| `llm_calls` | 该客户相关的 LLM 调用（operation / model / tokens / latency / cost / status） |
| `next_action` | `{ action, priority, due_in_days, reason, playbook[] }` |
| `allowed_transitions` | 当前状态允许跳转到的状态列表（终态为空数组） |

错误：`404 CUSTOMER_NOT_FOUND`。

---

### 2.5 GET /api/leads

线索列表（分页 + 搜索）。

```bash
curl "http://localhost:3000/api/leads?page=1&pageSize=20&search=robotics"
```

---

### 2.6 POST /api/leads/import

批量导入线索：去重（`email + company_name` 归一化哈希）→ 规则评分 → 创建客户与线索 → 写 `lead_imported` / `lead_scored` 事件。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `leads[]` | array 1-200 | 是 | 线索数组 |
| `leads[].company_name` | string | 是 | 公司名 |
| `leads[].email` | string(email) | 是 | 邮箱（去重键之一） |
| `leads[].contact_name` | string | 否 | 联系人 |
| `leads[].phone` / `website` / `industry` / `country` / `company_size` | string | 否 | 画像字段（参与评分） |
| `leads[].notes` | string | 否 | 备注（含"需求/预算/采购"等词会加分） |
| `leads[].score` | integer 0-100 | 否 | 显式指定评分（不传则规则计算） |
| `source` | string | 否 | 来源标识，默认 `api` |
| `score` | boolean | 否 | 是否评分，默认 true |
| `run_workflow` | boolean | 否 | 为导入的前若干客户立即跑完整工作流，默认 false |

```bash
curl -X POST http://localhost:3000/api/leads/import \
  -H "Content-Type: application/json" \
  -d '{
    "leads": [{
      "company_name": "Beijing Quantum Robotics",
      "contact_name": "Liu Yang",
      "email": "liu.yang@quantum-robotics.example.com",
      "phone": "+86-10-8899-1122",
      "website": "https://quantum-robotics.example.com",
      "industry": "工业机器人",
      "country": "CN",
      "company_size": "100-500",
      "notes": "展会收集，明确采购需求，预算已批"
    }],
    "source": "webinar"
  }'
```

响应（HTTP 201）：

```json
{
  "success": true,
  "data": {
    "imported": 1,
    "duplicated": 0,
    "total": 1,
    "leads": [
      {
        "lead_id": 11,
        "customer_id": 11,
        "email": "liu.yang@quantum-robotics.example.com",
        "company_name": "Beijing Quantum Robotics",
        "deduplicated": false,
        "score": 74,
        "score_reason": "等级 B｜行业匹配度一般(工业机器人) +10；团队规模(100-500) +24；目标市场(CN) +16；联系方式完整度 +20；备注含明确需求信号 +10",
        "status": "enriched",
        "created": true
      }
    ],
    "customers": [ { "id": 11, "company_name": "Beijing Quantum Robotics", "status": "enriched" } ],
    "workflow": null
  },
  "meta": { "request_id": "..." }
}
```

重复导入同一线索时：`imported: 0`、`duplicated: 1`、`leads[0].deduplicated: true`（不会重复创建客户）。

错误：`400 VALIDATION_ERROR`（空数组、邮箱格式错误等）。

---

### 2.7 POST /api/email/generate/{customerId}

调用 LLM 网关生成个性化开发信 → 落库 `email_messages` → 状态推进：

- `new → enriched → email_drafted`
- `send: true`（默认）时继续 `email_drafted → contacted`，并写 `email_sent` 事件

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `send` | boolean | true | 是否模拟发送并推进到 `contacted` |
| `sender_name` | string | Alex Chen | 发件人姓名 |
| `pain_point` | string | 行业库 | 自定义痛点 |
| `value_prop` | string | 行业库 | 自定义价值主张 |
| `language` | string | 中文为主 | 语言偏好 |
| `run_id` | string | - | 关联 Agent run |

```bash
curl -X POST http://localhost:3000/api/email/generate/1 \
  -H "Content-Type: application/json" -d '{"send":true}'
```

```json
{
  "success": true,
  "data": {
    "customer_id": 1,
    "email_id": 1,
    "subject": "Shenzhen Nova Electronics Co., Ltd. × 消费电子制造：把 B2B 线索转化率提升 30% 的 3 步方案",
    "body": "Hi Kevin Zhang，\n\n我是 B2B Sales Agent Demo Team 的 Alex Chen……",
    "status": "sent",
    "provider": "mock",
    "model": "mock",
    "prompt_tokens": 164,
    "completion_tokens": 160,
    "latency_ms": 1,
    "cost_usd": 0,
    "mock": true,
    "prompt_version": "v1.2.0",
    "from_status": "new",
    "to_status": "contacted",
    "status_changed": true
  },
  "meta": { "request_id": "..." }
}
```

错误：`404 CUSTOMER_NOT_FOUND`、`409 INVALID_STATUS_TRANSITION`、`502 LLM_ERROR` / `LLM_INVALID_OUTPUT`、`504 LLM_TIMEOUT`。

---

### 2.8 GET /api/email/customer/{customerId}

某客户的全部邮件记录（含 token 与耗时统计）。

```bash
curl http://localhost:3000/api/email/customer/1
```

---

### 2.9 POST /api/reply/analyze/{customerId}

接收客户回复（或生成模拟回复）→ LLM 意图分类（严格 JSON + Zod enum）→ 落库 `replies` → 状态推进 `replied → interested | needs_info | rejected | neutral`。

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `body` | string 1-8000 | - | 客户回复正文；留空且 `simulate: true` 时自动生成 |
| `simulate` | boolean | false | 自动生成模拟回复 |
| `intent` | enum | 按备注推断 | 指定模拟回复意图（仅 simulate 生效） |
| `email_message_id` | integer | 最近一封 | 关联邮件 |
| `run_id` | string | - | 关联 Agent run |
| `force` | boolean | false | 忽略状态机限制强制刷新状态（人工纠偏，仍写事件） |

```bash
# 真实回复文本
curl -X POST http://localhost:3000/api/reply/analyze/4 \
  -H "Content-Type: application/json" \
  -d '{"body":"我们对这个方案很感兴趣，下周二方便安排一次演示吗？"}'

# 模拟回复
curl -X POST http://localhost:3000/api/reply/analyze/4 \
  -H "Content-Type: application/json" -d '{"simulate":true,"intent":"interested"}'
```

```json
{
  "success": true,
  "data": {
    "customer_id": 4,
    "reply_id": 1,
    "reply_body": "Kevin Zhang，你好 Alex，\n\n感谢你的邮件，我们对这个方案很感兴趣……",
    "simulated": true,
    "classification": {
      "intent": "interested",
      "confidence": 0.8,
      "sentiment": "positive",
      "summary": "客户表达明确兴趣，建议尽快推进会议：Kevin Zhang，你好 Alex， 感谢你的邮件，我们对这个方案很感…",
      "suggested_action": "24 小时内发送会议邀约（附 3 个可选时段）",
      "needs_human": true
    },
    "provider": "mock",
    "model": "mock",
    "prompt_tokens": 244,
    "completion_tokens": 53,
    "latency_ms": 2,
    "cost_usd": 0,
    "mock": true,
    "prompt_version": "v1.3.0",
    "fallback": false,
    "from_status": "contacted",
    "to_status": "interested",
    "status_changed": true,
    "status_change_error": null
  },
  "meta": { "request_id": "..." }
}
```

> 分类失败（LLM 超时/限流/输出非法）时：`fallback: true`，使用规则兜底结果，并在 `llm_calls` 中记录 `status='error'`，**不会中断业务流程**。
> 若状态机拒绝跳转（如客户已是 `interested`），返回 `status_changed: false` 且 `status_change_error` 说明原因，分类结果仍完整保留。

---

### 2.10 GET /api/reply/customer/{customerId}

某客户的全部回复与分类结果。

```bash
curl http://localhost:3000/api/reply/customer/4
```

---

### 2.11 POST /api/agent/run

触发 Agent 工作流。执行过程写入 `agent_runs` 与 `agent_run_steps`。

| 工作流 | 步骤 |
|---|---|
| `full_cycle` | `score_lead` → `generate_email` →（发送）→ `classify_reply`（含 receive_reply）→ `suggest_next_action` |
| `import_and_draft` | `import_leads` → `score_lead` → `generate_email`（对前 `limit` 个客户） |
| `classify_only` | `classify_reply` → `suggest_next_action` |

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `workflow` | enum | `full_cycle` | 工作流名 |
| `customer_id` | integer | - | `full_cycle` / `classify_only` 必填 |
| `leads[]` | array | - | `import_and_draft` 必填 |
| `simulate_intent` | enum | 按备注推断 | 模拟客户回复意图 |
| `send_email` | boolean | true | 是否模拟发送 |
| `limit` | integer 1-50 | 1 | `import_and_draft` 处理客户数 |
| `trigger` | string | `api` | 调用方标识 |

```bash
curl -X POST http://localhost:3000/api/agent/run \
  -H "Content-Type: application/json" \
  -d '{"workflow":"full_cycle","customer_id":1,"simulate_intent":"interested","trigger":"curl"}'
```

```json
{
  "success": true,
  "data": {
    "run_id": "ef0f199a-9edb-45f9-a241-0c76418351b3",
    "workflow": "full_cycle",
    "status": "succeeded",
    "customer_id": 1,
    "error": null,
    "duration_ms": 19,
    "started_at": "2026-01-01T09:28:00.131Z",
    "finished_at": "2026-01-01T09:28:00.150Z",
    "llm_calls_count": 3,
    "total_tokens": 767,
    "total_cost_usd": 0,
    "steps": [
      { "step_index": 1, "tool": "score_lead", "status": "succeeded", "duration_ms": 2, "error": null, "summary": "评分 98 / 100（等级 A｜高价值行业(消费电子制造) +26；…）" },
      { "step_index": 2, "tool": "generate_email", "status": "succeeded", "duration_ms": 5, "error": null, "summary": "已生成邮件「Shenzhen Nova Electronics Co., Ltd. × 消费电子制造…」，状态 new → contacted" },
      { "step_index": 3, "tool": "classify_reply", "status": "succeeded", "duration_ms": 4, "error": null, "summary": "意图 interested（置信度 0.8），状态 contacted → interested" },
      { "step_index": 4, "tool": "suggest_next_action", "status": "succeeded", "duration_ms": 2, "error": null, "summary": "建议：24 小时内发送会议邀约（high，1 天内）" },
      { "step_index": 5, "tool": "score_lead", "status": "succeeded", "duration_ms": 1, "error": null, "summary": "评分 98 / 100（…）" }
    ],
    "output": {
      "workflow": "full_cycle",
      "customers": [
        {
          "customer_id": 1,
          "company_name": "Shenzhen Nova Electronics Co., Ltd.",
          "score": 98,
          "email_id": 1,
          "email_subject": "…",
          "reply_id": 1,
          "reply_body": "…",
          "intent": "interested",
          "confidence": 0.8,
          "needs_human": true,
          "suggested_action": "24 小时内发送会议邀约（附 3 个可选时段）",
          "from_status": "new",
          "to_status": "interested",
          "status_changed": true,
          "next_action": "24 小时内发送会议邀约",
          "llm": { "model": "mock", "provider": "mock", "prompt_tokens": 417, "completion_tokens": 218, "latency_ms": 3, "cost_usd": 0, "mock": true, "fallback": false }
        }
      ],
      "totals": { "customers": 1, "emails": 1, "replies": 1, "intent_changes": 1, "tokens": 635, "cost_usd": 0 }
    }
  },
  "meta": { "request_id": "...", "workflow": "full_cycle" }
}
```

错误：`400 VALIDATION_ERROR`（缺少 `customer_id` / `leads`、未知工作流）、`404 CUSTOMER_NOT_FOUND`。
工作流内部异常不会抛出 500，而是返回 `status: "failed"` 与 `error` 字段（便于前端展示与重试）。

---

### 2.12 GET /api/agent/tools

已注册工具与工作流清单。

```bash
curl http://localhost:3000/api/agent/tools
```

```json
{
  "success": true,
  "data": {
    "tools": [
      { "name": "import_leads", "description": "批量导入线索：去重、评分、创建客户与线索记录，并写 lead_imported / lead_scored 事件。" },
      { "name": "score_lead", "description": "对指定客户做线索评分（规则评分 + 理由 + 信号），并写 lead_scored 事件。" },
      { "name": "generate_email", "description": "基于客户画像调用 LLM 生成个性化开发信，落库并推进状态（email_drafted → contacted）。" },
      { "name": "classify_reply", "description": "接收（或模拟生成）客户回复，通过 LLM 网关做意图分类，写入 replies 并推进状态（replied → 意图状态）。" },
      { "name": "suggest_next_action", "description": "基于客户状态、评分与最近意图，给出下一步最佳动作（LLM 生成，失败降级为规则建议）。" }
    ],
    "tool_names": ["import_leads", "score_lead", "generate_email", "classify_reply", "suggest_next_action"],
    "workflows": [
      { "name": "full_cycle", "description": "完整链路：评分 → 生成开发信 → 模拟发送 → 模拟客户回复 → 意图分类 → 自动更新状态" },
      { "name": "import_and_draft", "description": "导入线索 → 评分 → 为前 N 个客户生成开发信（不模拟回复）" },
      { "name": "classify_only", "description": "只跑回复分类链路：模拟客户回复 → 意图分类 → 自动更新状态" }
    ]
  },
  "meta": { "request_id": "..." }
}
```

---

### 2.13 GET /api/agent/runs

Agent 执行记录列表。

| 参数 | 类型 | 说明 |
|---|---|---|
| `page` / `pageSize` | integer | 分页 |
| `customer_id` | integer | 按客户过滤 |
| `status` | enum | `running` / `succeeded` / `failed` |

```bash
curl "http://localhost:3000/api/agent/runs?page=1&pageSize=5&status=succeeded"
```

---

### 2.14 GET /api/agent/runs/{runId}

执行详情：每一步的输入/输出、LLM 调用明细（含 token/耗时/成本/尝试次数）、该 run 产生的全部事件。

```bash
curl http://localhost:3000/api/agent/runs/ef0f199a-9edb-45f9-a241-0c76418351b3
```

错误：`404 AGENT_RUN_NOT_FOUND`。

---

### 2.15 GET /api/dashboard/stats

看板统计（每 30 秒自动刷新由前端负责）。

```bash
curl http://localhost:3000/api/dashboard/stats
```

主要字段：

| 字段 | 说明 |
|---|---|
| `total_customers` / `total_leads` / `total_emails` / `total_replies` | 总量指标 |
| `by_status[]` | 11 个状态的客户数（含中文标签），供状态卡片 |
| `funnel[]` | 漏斗：`imported` → `contacted` → `replied` → `interested` → `meeting_booked` |
| `replied_rate` / `interested_rate` / `avg_score` | 比率与均值 |
| `llm` | `calls` / `prompt_tokens` / `completion_tokens` / `total_tokens` / `cost_usd` / `avg_latency_ms` / `errors` / `fallbacks` / `mock_calls` |
| `agent` | `runs` / `succeeded` / `failed` / `avg_duration_ms` |
| `intents[]` | 回复意图分布 |
| `recent_events[]` | 最近 15 条事件（含公司名） |
| `llm_mode` / `llm_model` / `agent_tools` | 运行环境信息 |

---

## 3. 数据库结构（供接口字段对照）

| 表 | 关键字段 |
|---|---|
| `leads` | `company_name`、`email`、`dedupe_hash`（唯一）、`score`、`score_reason`、`customer_id` |
| `customers` | `status`（CHECK 约束枚举）、`score`、`last_contacted_at`、`last_replied_at` |
| `email_messages` | `subject`、`body`、`status`、`model`、`prompt_tokens`、`completion_tokens`、`latency_ms`、`mock` |
| `replies` | `body`、`intent`、`confidence`、`sentiment`、`summary`、`suggested_action`、`needs_human` |
| `events` | `event_type`、`from_status`、`to_status`、`trigger`、`run_id`、`payload`（**append-only**） |
| `agent_runs` | `run_id`、`workflow`、`status`、`steps_count`、`llm_calls_count`、`total_tokens`、`total_cost_usd`、`duration_ms` |
| `agent_run_steps` | `run_id`、`step_index`、`tool`、`status`、`input`、`output`、`duration_ms` |
| `llm_calls` | `run_id`、`provider`、`model`、`operation`、`prompt_tokens`、`completion_tokens`、`latency_ms`、`cost_usd`、`status`、`attempt`、`mock`、`error` |

---

## 4. Postman

导入 `postman/collection.json`：

1. Postman → Import → 选择 `postman/collection.json`
2. 集合变量 `baseUrl` 默认 `http://localhost:3000`
3. 建议执行顺序：`Health` → `Customers / List` → `Leads / Import` → `Agent / Run Full Cycle` → `Agent / Run Detail` → `Dashboard / Stats`

集合内置测试脚本会校验：`success === true`、`meta.request_id` 存在、关键字段非空。
