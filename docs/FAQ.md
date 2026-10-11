# FAQ 与排障指南

覆盖：LLM 超时、429 限流、SQLite 数据库锁、端口占用、better-sqlite3 原生模块、Mock 模式、Docker、测试与覆盖率。

---

## 0. 快速自检清单

```bash
node -v                 # 期望 >= 20
npm run typecheck       # 期望无输出（0 错误）
npm run init-db         # 期望 9 张表 + 10 条 seed
npm test                # 期望 150 passed
npm run eval:intent     # 期望 总准确率 >= 80%
curl http://localhost:3000/health
```

---

## 1. LLM 超时（LLM_TIMEOUT / HTTP 504）

**现象**

```json
{ "success": false, "error": { "code": "LLM_TIMEOUT", "message": "LLM 请求超时（30000ms，第 4 次尝试）" } }
```

**原因**：`AbortController` 在 `LLM_TIMEOUT_MS` 内未收到响应。长 prompt、模型排队、网络抖动都会触发。

**排查**

1. 确认 base URL 与模型名：

```bash
curl -X POST "$LLM_BASE_URL/chat/completions" \
  -H "Authorization: Bearer $LLM_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"deepseek-flash","messages":[{"role":"user","content":"ping"}],"max_tokens":5}'
```

> 注意：`deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，用旧名字会直接报模型不存在。当前在售为 `deepseek-flash` 与 `deepseek-v4-pro`。

2. 查看该次调用的耗时与尝试次数：

```sql
SELECT operation, model, latency_ms, attempt, status, error
FROM llm_calls ORDER BY id DESC LIMIT 10;
```

3. 调大超时（注意：超时会随重试次数放大总耗时）：

```bash
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=1     # 重试次数越多，最坏耗时 ≈ (重试+1) × 超时
```

4. 开发/演示阶段可直接回归 Mock 模式：清空 `LLM_API_KEY` 即可，无网络依赖。

**设计说明**：超时**不会**让业务崩溃——意图分类会降级为规则兜底（`fallback: true`），邮件生成失败则返回明确错误码由调用方重试。

---

## 2. LLM 限流（LLM_RATE_LIMIT / HTTP 429）

**现象**：`{"code":"LLM_RATE_LIMIT","message":"HTTP 429: Rate limit reached"}`

**网关的自动处理**

1. 识别 429 → 读取响应头 `Retry-After`（支持秒数 `2` 与 HTTP 日期两种格式）；
2. 等待时间 = `Retry-After`（若存在）与指数退避 `500ms × 2^(n-1) + 抖动` 的较大值，上限 60s；
3. 仅对 429 / 5xx / 网络错误重试，最多 `LLM_MAX_RETRIES` 次（默认 3）；
4. 4xx（除 429）不重试，立即抛出。

**排查**

```sql
-- 查看是否在反复触顶
SELECT status, COUNT(*) FROM llm_calls GROUP BY status;
SELECT error, COUNT(*) FROM llm_calls WHERE status='error' GROUP BY error ORDER BY 2 DESC;
```

**缓解手段**

- 降低并发：批量导入 + `run_workflow` 会逐客户串行调用，但多客户端同时触发仍可能触顶；
- 降低单次请求体量：`generate_email` 的 prompt 已控制在 ~170 tokens；
- 提高 `LLM_MAX_RETRIES`，或换用配额更高的模型/账号；
- 演示阶段使用 Mock 模式（无速率限制）。

---

## 3. 数据库锁（SQLITE_BUSY / database is locked）

**已做的防护**（`src/db/db.ts`）

```ts
db.pragma('journal_mode = WAL');   // 读写并发（文件库）
db.pragma('foreign_keys = ON');    // 外键约束
db.pragma('busy_timeout = 5000');  // 遇锁等待 5 秒而非立刻报错
db.pragma('synchronous = NORMAL'); // WAL 下兼顾安全与性能
```

**仍然报错时**

1. **确认没有重复启动的进程**占用同一个库文件（最常见原因）：

```bash
# Windows
Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object OwningProcess
Get-Process -Name node | Select-Object Id, StartTime

# macOS / Linux
lsof -i :3000
```

2. **不要用 `:memory:` 期望跨进程共享**：内存库只在单进程内可见；
3. **避免长事务**：本项目所有事务都是同步小块（better-sqlite3 的 `db.transaction`）；
4. **不要用 GUI 工具（DB Browser 等）持有写锁**，只读打开时用 `readonly` 模式：

```js
new Database('./sales-agent.db', { readonly: true });
```

5. **WAL 文件异常**时重建（开发库可直接重置）：

```bash
npm run reset-db     # 删除 sales-agent.db / -wal / -shm 后重新建表 + seed
```

6. **网络盘/同步盘（OneDrive、Dropbox）** 上放数据库会放大锁问题，建议放到本地磁盘。

---

## 4. 端口占用（EADDRINUSE）

**现象**

```
Error: listen EADDRINUSE: address already in use :::3000
```

**排查与解决**

```bash
# Windows：找出占用者并结束
Get-NetTCPConnection -LocalPort 3000 -State Listen | ForEach-Object { Get-Process -Id $_.OwningProcess }
Stop-Process -Id <PID> -Force

# macOS / Linux
lsof -i :3000
kill -9 <PID>
```

**或换个端口**

```bash
PORT=3100 npm run dev
# 前端 proxy 需同步指向新端口
VITE_PROXY_TARGET=http://localhost:3100 npm run dev --prefix frontend
```

> 前端 `5173` 被占用时：`FRONTEND_PORT=5174 npm run dev --prefix frontend`（Vite 采用 `strictPort`，会明确报错而不是静默换端口）。

---

## 5. better-sqlite3 安装/加载失败

**现象 A：`Could not locate the bindings file` 或 `NODE_MODULE_VERSION` 不匹配**

原因：原生模块与当前 Node 主版本不匹配（换过 Node 版本、复制过 `node_modules`）。

```bash
# 重新编译
npm rebuild better-sqlite3

# 仍失败则彻底重装
rm -rf node_modules package-lock.json && npm install
```

**现象 B：`node-gyp` 编译失败（缺少构建工具）**

- Windows：安装 Visual Studio Build Tools（含 "Desktop development with C++"）与 Python 3.10+；
- Debian/Ubuntu：`apt-get install -y build-essential python3`；
- Alpine：`apk add --no-cache python3 make g++`；
- 或者直接使用 Docker（`Dockerfile` 已包含构建依赖，运行阶段复用编译产物）。

**现象 C：写库时进程被原生断言杀死**（`Assertion failed: (env) != nullptr`）

完整报错形如：

```
  #  C:\...\node.exe[30512]: void __cdecl node::RemoveEnvironmentCleanupHook(Isolate *, CleanupHook, void *) at src\api\hooks.cc:142
  #  Assertion failed: (env) != nullptr
 4: Statement::`scalar deleting destructor'+301
```

**根因（已在 v13 修复）**：`better-sqlite3@12.x` 的预编译二进制与 **Node.js 24** 组合，在 `Statement` 对象被 GC 析构时会触发 native 断言并 `abort()` 进程。特征是**读全正常、一写就崩**，且崩溃时机随机（取决于 GC）。

**处理**：升级到声明支持 Node ≥22 的 v13。

```bash
npm install better-sqlite3@^13.0.3
npm rebuild better-sqlite3     # 必要时强制重新拉取预编译二进制
```

验证修复（连续 25 次写库不崩）：

```bash
# 启动后端后重复触发写操作
for ($i=1; $i -le 25; $i++) {
  Invoke-RestMethod 'http://127.0.0.1:3000/api/agent/run' -Method Post -ContentType 'application/json' `
    -Body (@{ workflow='full_cycle'; customer_id=1; simulate_intent='interested' } | ConvertTo-Json)
}
```

若暂时无法升级，可临时降级 Node 到 22 LTS（`nvm use 22`），v12 在 Node 22 上稳定。

**其他可能原因**（排除 v13 后仍崩溃时再查）：同一个 SQLite 文件被多个进程同时打开、其中一个被强杀；或用 `taskkill /F` 杀掉正在写 WAL 的进程后残留了 `-wal` / `-shm`。处理：

```bash
# 1) 清掉所有后端进程
Get-Process -Name node | Stop-Process -Force      # Windows
# 2) 检查完整性，必要时重建
node -e "const D=require('better-sqlite3');const db=new D('./sales-agent.db');console.log(db.pragma('integrity_check',{simple:true}));db.close();"
npm run reset-db
# 3) 重启单一实例
npm run dev
```

测试侧已通过 `pool: 'forks'` + `fileParallelism: false`（`vitest.config.ts`）规避多进程同时开关 SQLite 的冲突。

---

## 5.1 `attempt to write a readonly database`（SQLITE_READONLY）

**现象**：读接口全部正常（`/health`、客户列表都返回 200），但任何写操作返回 500：

```json
{ "success": false, "error": { "code": "INTERNAL_ERROR", "message": "attempt to write a readonly database" } }
```

**两个不同的原因，先分辨再处理**：

| 检查 | 命令 | 说明 |
|---|---|---|
| 文件权限 | `Get-Acl .\sales-agent.db \| Select-Object Owner, Access` | 看当前用户是否有 `FullControl` / `Modify` |
| 能否新建文件 | `'x' \| Set-Content .\__probe.txt` | 若这一步就被拒，说明**整个目录**不可写，与 SQLite 无关 |
| SQLite 单独写 | `node -e "const D=require('better-sqlite3');const db=new D('./sales-agent.db');db.prepare('INSERT INTO events (customer_id,event_type,trigger) VALUES (1,?,?)').run('probe','probe').toString()"` | 复现同一个错误码即确认是权限问题 |

- **原因 A：工作区/目录只读**（沙箱只读策略、受控文件夹访问、OneDrive 同步目录只读等）。
  处理：给当前用户对该目录的写权限；若在 DSH 里跑，把会话文件策略切到可写工作区（workspace-write）。
  SQLite 在 WAL 模式下连 `-wal` / `-shm` 都要写，所以**只读挂载 + WAL 一定失败**，读操作却完全正常——这正是本错误的典型特征。
- **原因 B：数据库文件本身被设为只读**
  ```powershell
  Get-ChildItem .\sales-agent.db* | Select-Object Name, IsReadOnly
  Set-ItemProperty .\sales-agent.db -Name IsReadOnly -Value $false
  ```
- **规避（只读环境做演示）**：改用内存库或临时库，读写都发生在进程内：
  ```bash
  DATABASE_PATH=:memory: npm run dev      # 注意：进程退出即丢数据
  ```

---

## 5.2 Windows PowerShell 里 `npm` 报「禁止运行脚本」

**现象**：

```
npm : 无法加载文件 C:\NodeJavaS\npm.ps1，因为在此系统上禁止运行脚本。
+ FullyQualifiedErrorId : UnauthorizedAccess
```

**原因**：Windows 默认执行策略 `Restricted` 禁止运行 `.ps1`，而 PowerShell 中的 `npm` 指向 `npm.ps1` 包装脚本。报错位置为 `行:1 字符:1`，说明在 npm 真正启动前就被拦下——**与项目无关**。

```powershell
npm.cmd run reset-db                          # 推荐：用 .cmd 包装，永久可用
Set-ExecutionPolicy -Scope Process Bypass     # 或仅当前窗口放开，无需管理员
```

```cmd
:: 或直接用 cmd 窗口
cd /d C:\DH-test && npm run reset-db
```

---

## 5.3 `reset-db` 报 EPERM：文件被进程占用

**现象**：

```
Error: EPERM, Permission denied: \\?\C:\DH-test\sales-agent.db
    at removeDatabaseFiles (C:\DH-test\src\db\init-db.ts:25:10)
```

**原因**：Windows 不允许删除仍被打开的文件，而后端进程持有 `sales-agent.db`、`-wal`、`-shm` 句柄。

```cmd
taskkill /F /IM node.exe      :: 1) 先释放句柄
cd /d C:\DH-test
npm run reset-db             :: 2) 再重置（会删库重建 10 条 seed）
npm run dev                  :: 3) 最后重启后端（前端不持有句柄，可不重启）
```

---

## 6. Mock 模式与真实 LLM 的差异

| 维度 | Mock 模式（`LLM_API_KEY` 为空） | 真实 LLM |
|---|---|---|
| 邮件生成 | 模板化、含客户名/行业/评分 | 模型自由生成（引用官网产品线等真实细节） |
| 意图分类 | 关键词规则打分（26 条样本 92.31%） | 模型判断（实测置信度 0.97，摘要为语义总结） |
| 耗时 | 1~3 ms | 数百 ms ~ 数秒 |
| 成本 | 恒为 0 | 按 `src/services/pricing.ts` 单价估算 |
| 标记 | `mock: true`（`llm_calls.mock=1`） | `mock: false` |
| 用途 | 演示、CI、单元测试 | 生产 |

> **实测数据对比**（邮件质量、tokens、耗时、成本换算、省钱开关）见 [LLM-COMPARISON.md](LLM-COMPARISON.md)。
> 一键复现：`npx tsx scripts/compare-llm-modes.ts 1`

**确认当前模式**

```bash
curl http://localhost:3000/health | grep -o '"mode":"[a-z]*"'
```

**Mock 模式下为什么 `cost_usd` 是 0？** 单价表中 `mock` 模型输入/输出均为 0，这是刻意设计：看板能同时展示"调用次数/ token 数"与"真实成本"。切换真实 Key 后成本会自动按模型单价计算。

DeepSeek 当前在售模型单价（来源 [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)）：

| 模型 | 输入（每 1M，峰值/低谷） | 输出（每 1M，峰值/低谷） | 本项目换算值（每 1K，取峰值保守估算） |
|---|---|---|---|
| `deepseek-flash` | $0.3 / $0.15 | $1.2 / $0.6 | 输入 $0.0003、输出 $0.0012 |
| `deepseek-v4-pro` | $1.32 / $0.66 | $3.96 / $1.98 | 输入 $0.00132、输出 $0.00396 |

> 高峰时段为 UTC 周一至周五 01:00–04:00 与 06:00–10:00（不含中国法定节假日），其余为低谷（半价）。
> 本项目单价表统一采用**峰值价**，因此看板显示的估算成本是**偏保守（不会低报）**的上限值。
> 旧模型名 `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，单价表中仅为兼容历史数据展示保留。

**思考模式（`LLM_THINKING`）**：DeepSeek 的 thinking 默认开启，会在正式回答前输出思维链 `reasoning_content`，**思维链按输出 token 计费**。本项目只消费 `content`、且意图分类要求严格 JSON，因此默认 `LLM_THINKING=disabled`：既省钱也避免思维链干扰 JSON 抽取。若关闭后仍希望模型推理更强，可改 `enabled` 或用 `low/high/max` 控制强度（会发送 `reasoning_effort`）。

---

## 7. 非法状态跳转（INVALID_STATUS_TRANSITION / HTTP 409）

**现象**

```json
{
  "success": false,
  "error": {
    "code": "INVALID_STATUS_TRANSITION",
    "message": "非法状态跳转: new → closed（允许的目标状态: enriched）",
    "details": { "from_status": "new", "to_status": "closed", "reason": "允许的目标状态: enriched" }
  }
}
```

**这不是 bug，而是状态机的保护**。合法跳转见 `GET /api/customers/status-machine`。

常见误区：

- 客户还没生成邮件就想直接标记 `contacted` → 先调 `POST /api/email/generate/:id`；
- 客户已 `interested`，又发来中性回复 → 状态不变（`status_changed: false`）但分类结果会完整记录；确实要覆盖时用 `force: true`（仍写事件留痕）；
- 终态 `closed` / `rejected` 不允许再迁移（`rejected` 只允许自环与 `closed`）。

---

## 8. Docker 相关

```bash
docker compose up --build      # 前端 5173，后端 3000
docker compose logs -f backend
docker compose down            # 停止（保留数据卷）
docker compose down -v         # 停止并删除数据卷（重置数据库）
```

常见问题：

| 现象 | 处理 |
|---|---|
| `port is already allocated` | 宿主机 3000/5173 被占用，先释放或改 `docker-compose.yml` 的端口映射 |
| 前端能开但接口 404 | nginx 依赖 `backend` 服务名，确认 `docker compose ps` 中 backend 为 healthy |
| 数据不持久 | 数据在命名卷 `sales-agent-data`；`down -v` 会删除它 |
| healthcheck 一直 unhealthy | 容器内 `fetch` 不可用通常意味着启动即崩溃，看 `docker compose logs backend` |

---

## 9. 测试与覆盖率

```bash
npm test                       # 150 个测试
npm run test:watch             # 监听模式
npm run test:coverage          # 覆盖率（阈值：核心 service ≥ 80%）
npm run eval:intent            # 意图分类准确率（默认阈值 80%，可用 EVAL_MIN_ACCURACY 调整）
EVAL_MIN_ACCURACY=90 npm run eval:intent   # 提高门槛（不达标时退出码 1，便于 CI）
npm run eval:intent -- --json  # 机器可读结果（含混淆矩阵与每条明细）
npm run eval:intent -- --limit 5
```

**覆盖率报告位置**

| 形式 | 路径 | 用途 |
|---|---|---|
| 终端表格 | 命令输出 | 快速查看 |
| HTML | `coverage/index.html` | 逐行查看未覆盖代码 |
| LCOV | `coverage/lcov.info` | CI（Codecov / Coveralls / SonarQube） |
| JSON | `coverage/coverage-final.json` | 自定义分析 |

> `coverage/` 已在 `.gitignore` 中，不入库。

**覆盖率统计范围**：`src/services/**`、`src/core/**`、`src/harness/**`、`src/db/**`（排除 CLI 入口 `init-db.ts`、`seed.ts`、`run-cli.ts`）。

**测试设计要点**

- 每个用例独立临时数据库（`tests/helpers/testDb.ts` 里的 `createTestContext`），避免相互污染；
- LLM 全部走 Mock，配合 `fetchImpl` 注入可在无网络环境确定性地验证超时/429/5xx/网络错误；
- `vitest.config.ts` 使用 `pool: 'forks'` + `fileParallelism: false`，规避原生模块与 SQLite 文件的并发问题。

---

## 10. 前端相关

| 现象 | 原因与处理 |
|---|---|
| 页面顶部显示「后端未连接」 | 后端未启动或端口不是 3000；先 `npm run dev`，或设置 `VITE_PROXY_TARGET` |
| 接口 404（`/api/...`） | Vite proxy 只代理 `/api` 与 `/health`；自定义路径需在 `frontend/vite.config.ts` 增加 |
| 数据不刷新 | TanStack Query 默认 `staleTime: 10s`；写操作后 hook 会自动 invalidate，也可手动刷新页面 |
| 表格中文列宽异常 | Tailwind 已在 `index.css` 配置中文字体栈，若自定义主题请保留 `font-family` |
| 生产构建后接口 404 | 生产用 `nginx.conf` 反代 `/api` 到 `backend:3000`；纯静态托管需自行配置反代或设置 `VITE_API_BASE_URL` |

---

## 11. 日志与可观测性排查

日志是 JSON（pino），可直接管道给 `jq`：

```bash
LOG_LEVEL=debug npm run dev | jq 'select(.msg=="llm_call") | {operation, model, prompt_tokens, latency_ms, cost_usd, status}'
```

关键字段：

| 场景 | 过滤条件 |
|---|---|
| HTTP 访问日志 | `.msg` 形如 `POST /api/agent/run 200 40ms`，含 `req.method` / `res.status` / `responseTime` / `request_id` |
| LLM 调用 | `.msg == "llm_call"`（含 `run_id` / `tokens` / `latency_ms` / `cost_usd` / `mock`） |
| LLM 重试 | `.msg == "llm_call_retry"`（含 `attempt` / `delay_ms` / `retry_after_ms`） |
| Agent 执行 | `.msg == "agent_run_finished"`（含 `steps` / `llm_calls` / `total_tokens` / `duration_ms`） |
| 请求被拒 | `.msg == "request rejected"`（含 `code` / `details`） |

数据库侧排查：

```sql
-- 最近 20 次 LLM 调用的成本与耗时
SELECT operation, model, prompt_tokens, completion_tokens, latency_ms, ROUND(cost_usd, 6) AS cost, status
FROM llm_calls ORDER BY id DESC LIMIT 20;

-- 某客户的完整状态轨迹
SELECT from_status, to_status, trigger, created_at FROM events
WHERE customer_id = 1 AND event_type = 'status_changed' ORDER BY id;

-- 失败的 Agent 步骤
SELECT s.run_id, s.step_index, s.tool, s.error FROM agent_run_steps s
WHERE s.status = 'failed' ORDER BY s.id DESC LIMIT 20;
```

---

## 12. 重置与清理

```bash
npm run reset-db          # 删库重建（10 条 seed）
npm run seed              # 仅补 seed（幂等）
rm -rf coverage dist      # 清理构建与覆盖率产物
npm run format            # Prettier 统一格式
npm run lint              # ESLint 检查
```

> `events` 表是 append-only（触发器拦截 UPDATE/DELETE），需要清空时必须走 `npm run reset-db`，这是刻意设计。
