import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAgentTools, useCustomers, useImportLeads, useRunAgent } from '../api/hooks';
import { REPLY_INTENTS, type AgentRunResult, type ReplyIntent } from '../api/types';
import { IntentBadge, StatusBadge } from '../components/Badges';
import { Card, EmptyState, ErrorBox, JsonBlock, Spinner } from '../components/ui';
import { formatCost, formatDateTime, intentLabel } from '../lib/format';

const SAMPLE_LEADS = JSON.stringify(
  [
    {
      company_name: 'Beijing Quantum Robotics',
      contact_name: 'Liu Yang',
      email: 'liu.yang@quantum-robotics.example.com',
      phone: '+86-10-8899-1122',
      website: 'https://quantum-robotics.example.com',
      industry: '工业机器人',
      country: 'CN',
      company_size: '100-500',
      notes: '展会收集，明确采购需求，预算已批',
    },
    {
      company_name: 'Amsterdam WindMill Analytics',
      contact_name: 'Peter de Vries',
      email: 'peter.devries@windmill-analytics.example.com',
      website: 'https://windmill-analytics.example.com',
      industry: '数据服务',
      country: 'NL',
      company_size: '50-100',
      notes: '计划评估销售自动化，需要更多信息与报价',
    },
  ],
  null,
  2,
);

export const WorkflowPage = () => {
  const [searchParams] = useSearchParams();
  const initialCustomer = searchParams.get('customer');

  // 注意：sortBy 必须是后端允许的枚举（created_at / updated_at / score / company_name），
  // 传 'id' 会被后端 Zod 拒绝（400 VALIDATION_ERROR），导致下拉框静默为空。
  const customersQuery = useCustomers({
    page: 1,
    pageSize: 100,
    sortBy: 'created_at',
    sortOrder: 'asc',
  });
  const toolsQuery = useAgentTools();
  const runAgent = useRunAgent();
  const importLeads = useImportLeads();

  const [customerId, setCustomerId] = useState<number | null>(
    initialCustomer ? Number(initialCustomer) : null,
  );
  const [workflow, setWorkflow] = useState<'full_cycle' | 'import_and_draft' | 'classify_only'>(
    'full_cycle',
  );
  const [simulateIntent, setSimulateIntent] = useState<ReplyIntent>('interested');
  const [sendEmail, setSendEmail] = useState(true);
  const [leadsText, setLeadsText] = useState(SAMPLE_LEADS);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [result, setResult] = useState<AgentRunResult | null>(null);

  const customers = useMemo(() => customersQuery.data?.items ?? [], [customersQuery.data]);
  const selected = useMemo(
    () => customers.find((customer) => customer.id === customerId) ?? null,
    [customers, customerId],
  );

  /** 切换客户时清空上一次结果，避免把旧结果误读成本次执行 */
  const handleCustomerChange = (nextId: number | null) => {
    setCustomerId(nextId);
    setResult(null);
  };

  const handleRun = () => {
    if (workflow === 'import_and_draft') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(leadsText);
      } catch (error) {
        setLeadsError(`JSON 解析失败：${(error as Error).message}`);
        return;
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        setLeadsError('请提供至少 1 条线索（JSON 数组）');
        return;
      }
      setLeadsError(null);
      runAgent.mutate(
        { workflow, leads: parsed, send_email: sendEmail, limit: 2 },
        { onSuccess: (data) => setResult(data) },
      );
      return;
    }

    if (customerId === null) {
      setLeadsError('请先选择客户');
      return;
    }
    setLeadsError(null);
    runAgent.mutate(
      {
        workflow,
        customer_id: customerId,
        simulate_intent: simulateIntent,
        send_email: sendEmail,
      },
      { onSuccess: (data) => setResult(data) },
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">工作流触发</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          一键运行 Agent 工作流：score_lead → generate_email → send → receive_reply → classify_reply →
          update_status。每一步的输入/输出都会写入 agent_run_steps。
        </p>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="1. 选择工作流" className="lg:col-span-1">
          {toolsQuery.isLoading && <Spinner />}
          {toolsQuery.data && (
            <div className="space-y-3">
              {toolsQuery.data.workflows.map((item) => (
                <label
                  key={item.name}
                  className={`block cursor-pointer rounded-lg border p-3 text-sm transition-colors ${
                    workflow === item.name
                      ? 'border-brand-400 bg-brand-50'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    className="mr-2"
                    checked={workflow === item.name}
                    onChange={() => setWorkflow(item.name as typeof workflow)}
                  />
                  <span className="font-medium text-slate-800">{item.name}</span>
                  <p className="mt-1 text-xs text-slate-500">{item.description}</p>
                </label>
              ))}
              <div className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                <div className="font-medium text-slate-700">已注册工具</div>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {toolsQuery.data.tools.map((tool) => (
                    <li key={tool.name}>
                      <span className="font-mono">{tool.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Card>

        <Card title="2. 参数" className="lg:col-span-2">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="label">
                目标客户
                {customersQuery.isSuccess && (
                  <span className="ml-2 font-normal normal-case tracking-normal text-slate-400">
                    已加载 {customers.length} 个客户
                  </span>
                )}
              </div>
              <select
                className="input"
                value={customerId ?? ''}
                onChange={(event) =>
                  handleCustomerChange(event.target.value ? Number(event.target.value) : null)
                }
                disabled={workflow === 'import_and_draft' || customersQuery.isLoading}
              >
                <option value="">
                  {customersQuery.isLoading
                    ? '加载客户中…'
                    : customersQuery.isError
                      ? '客户列表加载失败'
                      : customers.length === 0
                        ? '暂无客户（请先导入线索）'
                        : '请选择客户…'}
                </option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    #{customer.id} {customer.company_name}（{customer.status} / {customer.score} 分）
                  </option>
                ))}
              </select>

              {/* 显式暴露加载/失败/空三态：避免请求失败时下拉框静默为空 */}
              {customersQuery.isLoading && (
                <p className="mt-1 text-xs text-slate-400">正在从 /api/customers 拉取客户列表…</p>
              )}
              {customersQuery.isError && (
                <div className="mt-2 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
                  <div className="font-semibold">客户列表加载失败</div>
                  <div className="mt-0.5 break-words">
                    {customersQuery.error instanceof Error
                      ? customersQuery.error.message
                      : String(customersQuery.error)}
                  </div>
                  <button
                    type="button"
                    className="mt-1 underline hover:no-underline"
                    onClick={() => void customersQuery.refetch()}
                  >
                    重新加载
                  </button>
                </div>
              )}
              {customersQuery.isSuccess && customers.length === 0 && (
                <p className="mt-1 text-xs text-amber-600">
                  数据库里还没有客户，先到「客户列表」页导入线索，或用下方「仅导入线索」按钮。
                </p>
              )}

              {selected && (
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                  <StatusBadge status={selected.status} />
                  <IntentBadge intent={selected.last_intent} />
                  <span>邮件 {selected.emails_count} · 回复 {selected.replies_count}</span>
                  <Link className="text-brand-600 hover:underline" to={`/customers/${selected.id}`}>
                    查看详情 →
                  </Link>
                </div>
              )}
            </div>

            <div>
              <div className="label">模拟客户回复意图</div>
              <select
                className="input"
                value={simulateIntent}
                onChange={(event) => setSimulateIntent(event.target.value as ReplyIntent)}
                disabled={workflow === 'import_and_draft'}
              >
                {REPLY_INTENTS.map((intent) => (
                  <option key={intent} value={intent}>
                    {intentLabel(intent)}（{intent}）
                  </option>
                ))}
              </select>
              <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={(event) => setSendEmail(event.target.checked)}
                />
                生成后模拟发送（状态推进到 contacted）
              </label>
            </div>
          </div>

          {workflow === 'import_and_draft' && (
            <div className="mt-4">
              <div className="label">线索 JSON（数组）</div>
              <textarea
                className="input h-56 font-mono text-xs"
                value={leadsText}
                onChange={(event) => setLeadsText(event.target.value)}
              />
            </div>
          )}

          {leadsError && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              {leadsError}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className="btn-primary" onClick={handleRun} disabled={runAgent.isPending}>
              {runAgent.isPending ? '执行中…' : '▶ 运行工作流'}
            </button>
            <button
              className="btn-secondary"
              disabled={importLeads.isPending}
              onClick={() => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(leadsText);
                } catch (error) {
                  setLeadsError(`JSON 解析失败：${(error as Error).message}`);
                  return;
                }
                setLeadsError(null);
                importLeads.mutate({ leads: parsed as unknown[], source: 'frontend' });
              }}
            >
              {importLeads.isPending ? '导入中…' : '⬆ 仅导入线索'}
            </button>
            <span className="text-xs text-slate-500">
              工作流执行会真实写库：邮件、回复、事件与 LLM 调用记录都会持久化。
            </span>
          </div>

          {importLeads.isSuccess && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
              导入完成：新增 {importLeads.data.imported} 条，重复 {importLeads.data.duplicated} 条（共{' '}
              {importLeads.data.total} 条）
            </div>
          )}
          {importLeads.isError && (
            <div className="mt-3">
              <ErrorBox title="导入失败" error={importLeads.error} />
            </div>
          )}
        </Card>
      </div>

      {runAgent.isError && <ErrorBox title="工作流执行失败" error={runAgent.error} />}

      {runAgent.isPending && (
        <Card title="执行中">
          <Spinner label="正在运行 Agent 工作流（Mock 模式下通常 < 1 秒）…" />
        </Card>
      )}

      {result && (
        <>
          <Card
            title={`执行结果 · ${result.workflow}`}
            subtitle={`run_id: ${result.run_id}`}
            actions={
              <span
                className={`rounded-full border px-3 py-1 text-xs font-medium ${
                  result.status === 'succeeded'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-rose-200 bg-rose-50 text-rose-700'
                }`}
              >
                {result.status}
              </span>
            }
          >
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
              {[
                ['耗时', `${result.duration_ms}ms`],
                ['LLM 调用', `${result.llm_calls_count} 次`],
                ['总 tokens', result.total_tokens],
                ['总成本', formatCost(result.total_cost_usd)],
                ['完成时间', formatDateTime(result.finished_at)],
              ].map(([label, value]) => (
                <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
                  <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
                  <div className="mt-0.5 font-medium text-slate-800">{value}</div>
                </div>
              ))}
            </div>

            {result.error && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                {result.error}
              </div>
            )}

            <div className="mt-5 space-y-3">
              {result.steps.map((step) => (
                <div
                  key={`${step.step_index}-${step.tool}`}
                  className={`rounded-lg border p-3 ${
                    step.status === 'succeeded'
                      ? 'border-slate-200 bg-white'
                      : 'border-rose-200 bg-rose-50'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="grid h-6 w-6 place-items-center rounded-full bg-slate-900 text-xs text-white">
                        {step.step_index}
                      </span>
                      <span className="font-mono text-sm font-medium text-slate-800">{step.tool}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${
                          step.status === 'succeeded'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-rose-200 bg-rose-100 text-rose-700'
                        }`}
                      >
                        {step.status}
                      </span>
                    </div>
                    <span className="text-xs text-slate-500">{step.duration_ms}ms</span>
                  </div>
                  {step.summary && <div className="mt-2 text-sm text-slate-700">{step.summary}</div>}
                  {step.error && <div className="mt-2 text-sm text-rose-700">{step.error}</div>}
                </div>
              ))}
            </div>

            {result.output && result.output.customers.length > 0 && (
              <div className="mt-5 space-y-3">
                <h3 className="text-sm font-semibold text-slate-800">客户结果</h3>
                {result.output.customers.map((customer) => (
                  <div key={customer.customer_id} className="rounded-lg border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          className="font-medium text-brand-700 hover:underline"
                          to={`/customers/${customer.customer_id}`}
                        >
                          #{customer.customer_id} {customer.company_name || '（客户）'}
                        </Link>
                        <StatusBadge status={customer.from_status} />
                        <span className="text-slate-400">→</span>
                        <StatusBadge status={customer.to_status} />
                        {customer.intent && <IntentBadge intent={customer.intent} />}
                      </div>
                      <span className="text-xs text-slate-500">
                        {customer.llm.model ?? '-'} · tokens {customer.llm.prompt_tokens}/
                        {customer.llm.completion_tokens} · {customer.llm.latency_ms}ms ·{' '}
                        {formatCost(customer.llm.cost_usd)}
                        {customer.llm.mock && <span className="ml-1 text-amber-600">mock</span>}
                      </span>
                    </div>

                    {customer.email_subject && (
                      <div className="mt-3 text-sm">
                        <span className="text-xs uppercase tracking-wide text-slate-500">邮件主题</span>
                        <div className="text-slate-800">{customer.email_subject}</div>
                      </div>
                    )}

                    {customer.reply_body && (
                      <div className="mt-3">
                        <div className="text-xs uppercase tracking-wide text-slate-500">模拟客户回复</div>
                        <pre className="mt-1 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                          {customer.reply_body}
                        </pre>
                      </div>
                    )}

                    <div className="mt-3 grid gap-2 text-xs text-slate-600 md:grid-cols-2">
                      {customer.confidence !== null && (
                        <div>意图置信度：{customer.confidence}</div>
                      )}
                      {customer.suggested_action && <div>建议动作：{customer.suggested_action}</div>}
                      {customer.next_action && <div>下一步：{customer.next_action}</div>}
                      <div>
                        状态是否变更：{customer.status_changed ? '是' : '否'}
                        {customer.needs_human ? ' · 需人工介入' : ''}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-5">
              <div className="label">原始响应</div>
              <JsonBlock value={result} />
            </div>
          </Card>

          {result.output && (
            <Card title="本次执行合计">
              <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-6">
                {[
                  ['处理客户', result.output.totals.customers],
                  ['生成邮件', result.output.totals.emails],
                  ['收到回复', result.output.totals.replies],
                  ['状态变更', result.output.totals.intent_changes],
                  ['tokens', result.output.totals.tokens],
                  ['成本', formatCost(result.output.totals.cost_usd)],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
                    <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
                    <div className="mt-0.5 font-medium text-slate-800">{value}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}

      {!result && !runAgent.isPending && (
        <Card title="提示">
          <EmptyState text="选择客户与工作流后点击“运行工作流”，即可看到每一步的工具、耗时与结果。" />
        </Card>
      )}
    </div>
  );
};

export default WorkflowPage;
