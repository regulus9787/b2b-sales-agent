# 验证记录（VERIFICATION）

本文件记录本项目在开发环境中**实际执行过**的验证命令与真实输出，便于复核与面试演示。

- 环境：Windows / Node.js v24.21.0 / npm 11.19.0
- LLM 模式：Mock（`LLM_API_KEY` 为空，零密钥跑通全流程）
- 生成日期：项目交付时

---

## 1. 依赖安装

```bash
npm install                       # 后端：396 packages
npm install --prefix frontend     # 前端：161 + 101（lint 工具）packages
```

原生模块 `better-sqlite3` 安装后可用性验证：

```bash
node -e "const D=require('better-sqlite3'); const db=new D(':memory:'); db.exec('create table t(a)'); db.prepare('insert into t values (?)').run(1); console.log('BETTER_SQLITE3_OK', db.prepare('select count(*) c from t').get());"
```

```
BETTER_SQLITE3_OK { c: 1 }
ESBUILD_OK 0.28.2
```

关键依赖版本：`express@5.3.0`、`better-sqlite3@12.11.1`、`zod@3.25.76`、`pino@10.4.0`、`vitest@3.2.7`、`typescript@5.9.3`。

---

## 2. 数据库初始化

```bash
npm run reset-db
```

```
[init-db] 已删除 C:\DH-test\sales-agent.db
[init-db] 已删除 C:\DH-test\sales-agent.db-wal
[init-db] 已删除 C:\DH-test\sales-agent.db-shm
[init-db] 数据库路径: C:\DH-test\sales-agent.db
[init-db] schema 版本: 2 / 目标 2
[init-db] 表清单(9): agent_run_steps, agent_runs, customers, email_messages, events, leads, llm_calls, replies, schema_migrations
[seed] 插入 10 条客户，跳过 0 条已存在客户
[init-db] 完成 ✓  新增客户 10 条（跳过 0），当前 leads=10 customers=10 events=10
```

幂等性：再次执行 `npm run init-db` → `新增客户 0 条（跳过 10）`。

---

## 3. 类型检查与 Lint

```bash
npm run typecheck                 # tsc --noEmit
npm run lint                      # eslint（后端）
npm run dev --prefix frontend ... # 前端 tsc -b + eslint
```

| 检查项 | 结果 |
|---|---|
| 后端 `tsc --noEmit`（strict + noUncheckedIndexedAccess） | 0 错误 |
| 后端 `eslint` | 0 error / 0 warning |
| 前端 `tsc -b` | 0 错误 |
| 前端 `eslint` | 0 error / 0 warning |
| 前端 `vite build` | ✓ 145 modules transformed，`dist/assets/index-*.js` 300.93 kB（gzip 96.80 kB） |

---

## 4. 测试与覆盖率

```bash
npm test
```

```
 ✓ tests/integration/api.test.ts (33 tests) 1066ms
 ✓ tests/unit/llm.test.ts (19 tests) 1946ms
 ✓ tests/unit/agent.test.ts (16 tests) 96ms
 ✓ tests/integration/workflow.test.ts (10 tests) 44ms
 ✓ tests/unit/customer.test.ts (13 tests) 46ms
 ✓ tests/unit/reply.test.ts (15 tests) 47ms
 ✓ tests/unit/lead.test.ts (16 tests) 36ms
 ✓ tests/unit/email.test.ts (9 tests) 35ms
 ✓ tests/unit/events.test.ts (7 tests) 19ms
 ✓ tests/unit/status.test.ts (12 tests) 3ms

 Test Files  10 passed (10)
      Tests  150 passed (150)
   Duration  5.50s
```

```bash
npm run test:coverage
```

```
All files       | % Stmts 94.88 | % Branch 78.58 | % Funcs 91.40 | % Lines 94.88
 core           |        97.50 |         91.80 |        96.42 |        97.50
 services       |        95.06 |         80.74 |        89.85 |        95.06
 harness        |        94.29 |         67.16 |       100.00 |        94.29
 db             |        88.34 |         69.56 |        70.00 |        88.34
```

核心 service 行覆盖率 **95.06%**，高于 AGENTS.md 要求的 80%。

---

## 5. 意图分类评估

```bash
npm run eval:intent
```

```
=========================================================
 B2B Sales Agent —— 意图分类评估 (npm run eval:intent)
=========================================================
模式      : Mock（规则分类器，无需 API Key）
样本文件  : C:\DH-test\data\intent-eval.jsonl
样本数    : 26
---------------------------------------------------------
...
混淆矩阵（行=期望，列=预测）
            interested  needs_info  rejected    neutral
interested  6           0           0           1
needs_info  0           6           0           1
rejected    0           0           6           0
neutral     0           0           0           6
---------------------------------------------------------
总准确率  : 92.31%  (24/26)
平均耗时  : 1ms
总 tokens : 6519
降级次数  : 0
分类别准确率：
  - interested   85.71%  (6/7)
  - needs_info   85.71%  (6/7)
  - rejected       100%  (6/6)
  - neutral        100%  (6/6)
PASS：准确率阈值 80%（可用 EVAL_MIN_ACCURACY 调整）
```

---

## 6. 端到端 HTTP 验证（真实运行）

启动：

```bash
npm run dev                      # 后端 http://localhost:3000
npm run dev --prefix frontend    # 前端 http://localhost:5173
```

### 6.1 健康检查

```
GET /health → mode=mock schema_v=2 tools=5
```

### 6.2 初始看板

```
GET /api/dashboard/stats → customers=10 emails=0 replies=0 llm_calls=0
```

### 6.3 导入线索（去重 + 评分）

```
POST /api/leads/import
imported=2 duplicated=0
  lead #11 -> customer #11 score=66 status=new
  lead #12 -> customer #12 score=62 status=new
```

### 6.4 完整工作流

```
POST /api/agent/run  {workflow: full_cycle, customer_id: 11, simulate_intent: interested}
run_id=712508ff-b118-4715-ab82-9030fa9d836e
status=succeeded steps=5 llm_calls=3 tokens=752 duration=14ms
  1. [succeeded] score_lead        0ms -> 评分 66 / 100（等级 B｜…）
  2. [succeeded] generate_email    5ms -> 已生成邮件「Nova Quantum Robotics × 工业机器人…」，状态 new → contacted
  3. [succeeded] classify_reply    5ms -> 意图 interested（置信度 0.84），状态 contacted → interested
  4. [succeeded] suggest_next_action 1ms -> 建议：24 小时内发送会议邀约（high，1 天内）
  5. [succeeded] score_lead        1ms -> 评分 66 / 100（等级 B｜…）
结果: new -> interested | intent=interested conf=0.84 needs_human=True
```

### 6.5 执行详情（每步 + LLM 调用 + 事件）

```
GET /api/agent/runs/712508ff-b118-4715-ab82-9030fa9d836e
steps=5 llm_calls=3 events=13

LLM: generate_email      model=mock tokens=151/154 latency=1ms cost=0 status=success mock=True
LLM: classify_intent     model=mock tokens=244/57  latency=2ms cost=0 status=success mock=True
LLM: suggest_next_action model=mock tokens=97/49   latency=1ms cost=0 status=success mock=True

EVENT: agent_run_started  -            -> -            trigger=final-check
EVENT: lead_scored        new          -> new          trigger=score_lead
EVENT: email_generated    new          -> new          trigger=generate_email
EVENT: status_changed     new          -> enriched     trigger=generate_email
EVENT: status_changed     enriched     -> email_drafted trigger=generate_email
EVENT: status_changed     email_drafted-> contacted     trigger=send_email
EVENT: email_sent         email_drafted-> contacted     trigger=send_email
EVENT: status_changed     contacted    -> replied      trigger=receive_reply
EVENT: reply_received     replied      -> replied      trigger=simulate_reply
EVENT: reply_classified   replied      -> replied      trigger=classify_reply
EVENT: status_changed     replied      -> interested   trigger=classify_reply
EVENT: lead_scored        interested   -> interested   trigger=score_lead
EVENT: agent_run_finished -            -> -            trigger=final-check
```

> 完整状态链 `new → enriched → email_drafted → contacted → replied → interested` 全部落库，每一步都有 trigger 与 run_id 可追溯。

### 6.6 前端与代理

```
GET http://localhost:5173/                     → 200，含 #root
GET http://localhost:5173/src/main.tsx         → 200（Vite 编译通过，4247 bytes）
GET http://localhost:5173/src/App.tsx          → 200（6636 bytes）
GET http://localhost:5173/src/components/Layout.tsx          → 200（18712 bytes）
GET http://localhost:5173/src/pages/CustomersPage.tsx        → 200（40314 bytes）
GET http://localhost:5173/src/pages/CustomerDetailPage.tsx   → 200（76466 bytes）
GET http://localhost:5173/src/pages/WorkflowPage.tsx         → 200（85995 bytes）
GET http://localhost:5173/src/pages/DashboardPage.tsx        → 200（52573 bytes）
GET http://localhost:5173/src/index.css        → Tailwind 编译 32489 bytes，含 .card 工具类
GET http://localhost:5173/api/dashboard/stats  → 代理成功：customers=12 llm_calls=3 tokens=752
GET http://localhost:5173/health               → 代理成功：mode=mock
```

### 6.7 接口与文档产出

```bash
npm run openapi
```

```
[openapi] 已写入 C:\DH-test\docs\openapi.json
[openapi] 接口 15 个
[openapi] 数据模型 13 个：Meta, Error, ErrorResponse, Pagination, CustomerStatus, Customer, CustomerSummary, EmailMessage, Reply, Event, LeadImportItem, AgentStep, LlmCall
```

```
GET /docs/                 → 200（Swagger UI 页面）
GET /docs/openapi.json     → 15 个 path 全部注册
postman/collection.json    → 7 个分组 / 24 个请求，JSON 校验通过
docker-compose.yml         → YAML 解析通过（services: backend, frontend；ports；named volume；healthcheck）
```

---

## 7. 修复记录（回归验证）

### 7.1 工作流页客户下拉框为空（已修复）

**现象**：前端「工作流触发」页 →「2. 参数」→ 目标客户下拉框只有「请选择客户…」，没有任何客户可选。

**根因**：`frontend/src/pages/WorkflowPage.tsx` 向列表接口传了后端不接受的排序字段：

```
GET /api/customers?page=1&pageSize=100&sortBy=id&sortOrder=desc
→ 400 Bad Request（VALIDATION_ERROR：sortBy 只允许 created_at / updated_at / score / company_name）
```

请求被后端 Zod 拒绝 → `customersQuery.data` 为空 → `customers` 为空数组 → 下拉框没有任何 `<option>`。
同时该 query 的错误状态当时没有渲染，形成**静默失败**，界面上完全看不出是接口报错。

**修复内容**（只改 `WorkflowPage.tsx`）：

| 改动 | 说明 |
|---|---|
| `sortBy: 'id' as never` → `sortBy: 'created_at'` + `sortOrder: 'asc'` | 使用后端允许的枚举值，并按创建顺序稳定排列 |
| 增加加载/失败/空三态提示 | 加载中显示「加载客户中…」并禁用下拉框；失败显示红色错误框（透出后端 `VALIDATION_ERROR` 消息）并带「重新加载」按钮；无客户时提示先去导入线索 |
| 下拉框上方显示「已加载 N 个客户」 | 便于一眼确认数据是否到位 |
| 切换客户时清空上一次执行结果 | `handleCustomerChange` 里 `setResult(null)`，避免把旧结果误读成本次执行 |

**验证**：

```bash
cd frontend
npx tsc -b --force     # TSC_EXIT=0
npx eslint .           # LINT_EXIT=0
npm run build          # ✓ 145 modules transformed，BUILD_EXIT=0
```

```
# 修复后前端实际发出的请求（经 Vite 代理）
GET http://localhost:5173/api/customers?page=1&pageSize=100&sortBy=created_at&sortOrder=asc
→ HTTP 200，total=12，items=12（下拉框现在有 12 个选项）

# 对照：修复前的非法参数仍然被后端拒绝（说明前端必须改）
GET http://localhost:5173/api/customers?sortBy=id
→ 400 Bad Request
```

**附带修复的环境问题**：编辑文件时工具留下的临时目录（`frontend/src/pages/.WorkflowPage.tsx.*.tmpdir/`）会让 Vite 的 FS watcher 抛 `EBUSY` 并退出进程。已清理临时目录并重启前端开发服务器；若再次出现该报错，删除 `frontend/src/**` 下的 `*.tmpdir` 目录后重启即可。

### 7.2 写库时进程被原生断言杀死（已修复）

**现象**：任何写操作（`POST /api/agent/run`、`npm run reset-db` 之外的工作流写入）都会让后端进程直接消失，前端只能看到 `500` 或"后端未连接"。日志末尾固定出现：

```
#  C:\NodeJavaS\node.exe[30512]: void __cdecl node::RemoveEnvironmentCleanupHook(Isolate *, CleanupHook, void *) at src\api\hooks.cc:142
#  Assertion failed: (env) != nullptr

 3: node::RemoveEnvironmentCleanupHook+234
 4: Statement::`scalar deleting destructor'+301
```

**定位过程**（逐步排除，每步都有实测输出）：

| 假设 | 验证方式 | 结论 |
|---|---|---|
| 数据库文件损坏 | `PRAGMA integrity_check` | `ok`，排除 |
| 工作区权限问题（只读策略） | 对 `sales-agent.db` 直接 INSERT | 成功，排除 |
| 某个 pragma（WAL / foreign_keys / busy_timeout / synchronous）导致 | 6 个独立进程分别只开启一项 pragma 写入 | 全部正常，排除 |
| `tsx watch` 父子进程冲突 | 改用非 watch 的 `npx tsx src/index.ts` | 连写 5 次成功，但压力测试第 3 次仍崩溃，**不是根因** |
| **原生模块版本与 Node 24 不兼容** | 升级到声明支持 Node ≥22 的 `better-sqlite3@13.0.3` | **确认是根因** |

**根因**：`better-sqlite3@12.11.1` 的预编译二进制与 **Node.js 24.21.0** 的组合在 `Statement` 对象被 GC 析构时（`Statement::~Statement` → `node::RemoveEnvironmentCleanupHook`）触发 native 断言，进程被 `abort()`。触发条件是"有写入 + 有 GC 压力"，所以读操作完全正常、单进程小脚本也往往看不出问题，只有在持续写入的服务里才暴露。

**修复**：

```bash
npm install better-sqlite3@^13.0.3
# package.json: "better-sqlite3": "^13.0.3"（engines: node >=22）
```

**回归验证**（修复后）：

```
npx tsc --noEmit     → TSC_EXIT=0
npx vitest run       → Test Files 10 passed (10) / Tests 150 passed (150)

# 决定性压力测试：watch 模式下连续 25 次工作流写库
[1] OK new -> interested      intent=interested
[2] OK interested -> needs_info intent=needs_info
[3] OK needs_info -> rejected  intent=rejected
[4] OK rejected -> rejected    intent=neutral
成功 25 次 / 失败 0 次
进程存活 ✓ uptime=13.71s
```

修复前同样的测试在第 3 次请求时进程即崩溃。API 无破坏性变更，`src/db/db.ts`、迁移、seed、150 个测试全部无需改动。

### 7.3 Windows PowerShell 无法执行 npm（环境提示，非项目问题）

**现象**：在 PowerShell 里执行 `npm run reset-db` 报：

```
npm : 无法加载文件 C:\NodeJavaS\npm.ps1，因为在此系统上禁止运行脚本。
+ FullyQualifiedErrorId : UnauthorizedAccess
```

**原因**：Windows 默认执行策略为 `Restricted`，禁止运行 `.ps1`，而 PowerShell 里的 `npm` 指向 `npm.ps1` 包装脚本（错误位置是 `行:1 字符:1`，说明在 npm 启动前就被拦下）。

**三种解法**（任选）：

```powershell
npm.cmd run reset-db                                  # 方案 A：用 .cmd 包装，绕开 .ps1（推荐）
Set-ExecutionPolicy -Scope Process Bypass             # 方案 B：仅当前窗口放开，无需管理员
```

```cmd
:: 方案 C：改用 cmd 窗口
cd /d C:\DH-test && npm run reset-db
```

### 7.4 `reset-db` 报 EPERM（进程占用，非 bug）

**现象**：

```
Error: EPERM, Permission denied: \\?\C:\DH-test\sales-agent.db
    at removeDatabaseFiles (C:\DH-test\src\db\init-db.ts:25:10)
```

**原因**：Windows 不允许删除仍被进程打开的文件，而后端（`npm run dev`）持有 `sales-agent.db`、`-wal`、`-shm` 三个句柄。

**正确顺序**：

```cmd
taskkill /F /IM node.exe      :: 1) 先释放句柄
cd /d C:\DH-test
npm run reset-db             :: 2) 再重置
npm run dev                  :: 3) 最后重启后端
```

后端不需要为了重置数据库而改代码；只要先释放句柄，SQLite 每次写入都会重新检查权限。

---

## 8. 未在本环境验证的部分

| 项目 | 原因 | 建议 |
|---|---|---|
| `docker compose up --build` | 当前开发环境未安装 Docker（`docker` 命令不存在） | 在有 Docker 的机器上执行；compose 文件已通过 YAML 结构校验 |
| 真实 LLM 调用（DeepSeek / OpenAI / 豆包） | 未提供 `LLM_API_KEY` | 按 README 第 4 节配置 Key 后重跑 `npm run eval:intent` 与工作流 |
| 浏览器像素级 UI 校验 | 当前环境无浏览器自动化工具 | 打开 http://localhost:5173 人工确认四个页面 |

---

## 9. 复现步骤（最短路径）

```bash
npm install
npm install --prefix frontend
npm run init-db
npm run typecheck
npm test
npm run eval:intent
npm run dev                      # 终端 1
npm run dev --prefix frontend    # 终端 2
# 浏览器打开 http://localhost:5173
```
