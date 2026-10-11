# AGENTS.md — B2B Sales Agent Harness 规范

## 1. 项目定位
端到端 B2B 销售 Agent，覆盖：线索导入 → LLM 生成个性化邮件 → 客户状态管理 → 模拟回复 → LLM 意图分类 → 自动更新状态。带简易 React 前端看板。

## 2. 目录结构约束
src/
  core/           # 领域模型、状态机、事件定义
  db/             # 数据库连接、schema、migrations、seed
  services/       # llm, email, reply, lead, agent
  routes/         # Express 路由，薄层，不写业务逻辑
  middleware/     # 校验、错误处理、日志、request_id
  harness/        # Agent Runner、工具注册、工作流编排
  types/          # 共享类型
frontend/         # React 前端
docs/             # API 文档、FAQ、架构图
tests/            # unit / integration
postman/          # Postman collection

## 3. 数据库表
必须包含：
- leads：原始线索
- customers：客户
- email_messages：邮件记录
- replies：客户回复
- events：append-only 状态变更事件
- agent_runs：每次 Agent 执行记录
- agent_run_steps：工作流每一步输入/输出
- llm_calls：每次 LLM 调用记录 model、prompt_tokens、completion_tokens、latency_ms、cost、status、error

## 4. 客户状态机
new → enriched → email_drafted → contacted → replied
replied → interested / needs_info / rejected / neutral
interested → meeting_booked → closed
非法跳转返回 409，错误码 INVALID_STATUS_TRANSITION。
每次状态变更必须写 events 表，append-only，不可修改。

## 5. LLM 网关约束
禁止在路由层直接 fetch LLM。所有 LLM 调用必须通过 services/llm.ts。
必须实现：
- 超时：AbortController，默认 30s
- 重试：指数退避，最多 3 次，仅对 429/5xx/网络错误重试
- 限流：检测 429，读取 Retry-After
- 输出校验：意图分类必须返回严格 JSON，用 Zod enum 校验
- 降级：LLM 失败返回明确错误码，分类失败降级为 neutral 并记录
- Token 统计：记录 prompt_tokens、completion_tokens、预估成本
- Mock 模式：如果 LLM_API_KEY 为空，使用 mock LLM 返回固定邮件和分类，保证项目可演示

## 6. API 统一响应
成功：
{ "success": true, "data": {}, "meta": { "request_id": "uuid" } }
失败：
{ "success": false, "error": { "code": "ERROR_CODE", "message": "..." }, "meta": { "request_id": "uuid" } }

错误码至少包含：
VALIDATION_ERROR, CUSTOMER_NOT_FOUND, INVALID_STATUS_TRANSITION, LLM_TIMEOUT, LLM_RATE_LIMIT, LLM_ERROR, INTERNAL_ERROR。

所有入参必须 Zod 校验。分页接口支持 page、pageSize，返回 total。每个请求生成 request_id，用 crypto.randomUUID()。

## 7. 可观测性
- HTTP 请求记录：method、path、status、duration_ms、request_id
- LLM 调用记录：run_id、model、tokens、latency_ms、cost、status、error
- 状态变更记录：customer_id、from_status、to_status、trigger、timestamp
- 日志用 pino，输出 JSON

## 8. Agent 工作流
在 src/harness/ 实现 Agent Runner，支持注册工具：
- import_leads
- score_lead
- generate_email
- classify_reply
- suggest_next_action

每个工具有输入/输出 Zod schema。Agent 执行写入 agent_runs 和 agent_run_steps。支持完整工作流：
import_leads → score_lead → generate_email → send → receive_reply → classify_reply → update_status。

## 9. 前端页面
React 前端只需 4 个页面：
1. 客户列表页：表格、状态过滤、搜索、分页
2. 客户详情页：客户信息、邮件记录、回复记录、状态变更时间线
3. 工作流触发页：选客户，一键运行“生成邮件 → 模拟回复 → 意图分类 → 刷新状态”，显示每一步结果
4. 看板页：各状态客户数量统计卡片

用 TanStack Query 管理服务端状态，Tailwind 写样式，不引入复杂状态管理。Vite 配置 proxy 将 /api 代理到 http://localhost:3000。

## 10. 测试与评估
- 每个 service 有单元测试，mock LLM
- 核心链路有集成测试：导入 → 生成邮件 → 分类 → 状态更新
- 内置 20+ 条标注回复样本，运行 npm run eval:intent 输出意图分类准确率
- 测试覆盖率核心 service ≥ 80%

## 11. 交付物
GitHub 仓库必须包含：
- README.md：架构图 Mermaid、启动方式、环境变量说明
- docs/API.md：OpenAPI 生成的接口文档
- docs/FAQ.md：排障指南，包含 LLM 超时、限流、数据库锁、端口占用
- postman/collection.json：Postman 测试集合
- Dockerfile + docker-compose.yml
- .env.example
- 测试覆盖率报告说明

## 12. 环境变量
PORT=3000
LLM_API_KEY=
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_MODEL=deepseek-chat
LLM_TIMEOUT_MS=30000
LLM_MAX_RETRIES=3
DATABASE_PATH=./sales-agent.db
LOG_LEVEL=info
FRONTEND_PORT=5173
