import { Link } from 'react-router-dom';
import { useDashboardStats } from '../api/hooks';
import { StatusBadge } from '../components/Badges';
import { Card, EmptyState, ErrorBox, Spinner, StatCard } from '../components/ui';
import { formatCost, formatDateTime, formatNumber } from '../lib/format';

export const DashboardPage = () => {
  const query = useDashboardStats();

  if (query.isLoading) {
    return (
      <Card title="看板">
        <Spinner />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card title="看板">
        <ErrorBox title="加载统计失败（请确认后端已启动）" error={query.error} />
      </Card>
    );
  }

  if (!query.data) return <EmptyState text="暂无数据" />;

  const stats = query.data;
  const maxFunnel = Math.max(...stats.funnel.map((item) => item.count), 1);
  const maxStatusCount = Math.max(...stats.by_status.map((item) => item.count), 1);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">销售看板</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            各状态客户数量、转化漏斗、LLM 与 Agent 运行指标（每 30 秒自动刷新）
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {stats.llm_mode && (
            <span
              className={`rounded-full border px-2 py-1 ${
                stats.llm_mode === 'mock'
                  ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-700'
              }`}
            >
              LLM: {stats.llm_mode === 'mock' ? 'Mock 模式' : stats.llm_model}
            </span>
          )}
          <Link className="btn-secondary" to="/workflow">
            ⚡ 运行工作流
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label="客户总数" value={stats.total_customers} tone="brand" />
        <StatCard label="线索总数" value={stats.total_leads} />
        <StatCard label="已发邮件" value={stats.total_emails} />
        <StatCard label="客户回复" value={stats.total_replies} />
        <StatCard label="回复率" value={`${stats.replied_rate}%`} tone="success" />
        <StatCard label="有意向占比" value={`${stats.interested_rate}%`} tone="warn" />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="各状态客户数量" subtitle="点击状态可跳转到过滤后的客户列表" className="lg:col-span-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {stats.by_status.map((item) => (
              <Link
                key={item.status}
                to={`/customers?status=${item.status}`}
                className="rounded-lg border border-slate-200 p-3 transition-colors hover:border-brand-300 hover:bg-brand-50"
              >
                <div className="flex items-center justify-between">
                  <StatusBadge status={item.status} />
                  <span className="text-lg font-semibold text-slate-900">{item.count}</span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-slate-100">
                  <div
                    className="h-1.5 rounded-full bg-brand-500"
                    style={{ width: `${Math.round((item.count / maxStatusCount) * 100)}%` }}
                  />
                </div>
                <div className="mt-1 text-xs text-slate-500">{item.label}</div>
              </Link>
            ))}
          </div>
        </Card>

        <Card title="转化漏斗">
          <ul className="space-y-3">
            {stats.funnel.map((item) => (
              <li key={item.stage}>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-700">{item.label}</span>
                  <span className="font-medium text-slate-900">{item.count}</span>
                </div>
                <div className="mt-1 h-2 w-full rounded-full bg-slate-100">
                  <div
                    className="h-2 rounded-full bg-gradient-to-r from-brand-400 to-brand-600"
                    style={{ width: `${Math.round((item.count / maxFunnel) * 100)}%` }}
                  />
                </div>
                <div className="mt-0.5 text-xs text-slate-400">
                  {stats.total_customers > 0
                    ? `${((item.count / stats.total_customers) * 100).toFixed(1)}% of 全部客户`
                    : '-'}
                </div>
              </li>
            ))}
          </ul>
          <div className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            平均线索评分：<span className="font-semibold text-slate-800">{stats.avg_score}</span>
          </div>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="LLM 调用指标" subtitle="来自 llm_calls 表">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ['调用次数', formatNumber(stats.llm.calls)],
              ['总 tokens', formatNumber(stats.llm.total_tokens)],
              ['prompt tokens', formatNumber(stats.llm.prompt_tokens)],
              ['completion tokens', formatNumber(stats.llm.completion_tokens)],
              ['平均耗时', `${stats.llm.avg_latency_ms}ms`],
              ['预估成本', formatCost(stats.llm.cost_usd)],
              ['错误次数', stats.llm.errors],
              ['降级次数', stats.llm.fallbacks],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
                <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-0.5 font-medium text-slate-800">{value}</dd>
              </div>
            ))}
          </dl>
          {stats.llm.mock_calls > 0 && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              其中 {stats.llm.mock_calls} 次为 Mock 调用（未配置 LLM_API_KEY，成本为 0）
            </div>
          )}
        </Card>

        <Card title="Agent 运行指标" subtitle="来自 agent_runs 表">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ['运行次数', stats.agent.runs],
              ['成功', stats.agent.succeeded],
              ['失败', stats.agent.failed],
              ['平均耗时', `${stats.agent.avg_duration_ms}ms`],
            ].map(([label, value]) => (
              <div key={String(label)} className="rounded-lg bg-slate-50 p-3">
                <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-0.5 font-medium text-slate-800">{value}</dd>
              </div>
            ))}
          </dl>
          {stats.agent_tools && (
            <div className="mt-3 text-xs text-slate-500">
              已注册工具：
              {stats.agent_tools.map((tool) => (
                <span key={tool} className="ml-1 rounded bg-slate-100 px-1.5 py-0.5 font-mono">
                  {tool}
                </span>
              ))}
            </div>
          )}
        </Card>

        <Card title="回复意图分布">
          {stats.intents.length === 0 ? (
            <EmptyState text="暂无已分类回复" />
          ) : (
            <ul className="space-y-2 text-sm">
              {stats.intents.map((item) => (
                <li key={item.intent} className="flex items-center justify-between rounded-lg bg-slate-50 p-3">
                  <span className="text-slate-700">{item.intent}</span>
                  <span className="font-medium text-slate-900">{item.count}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="最近事件" subtitle="events 表最新 15 条（append-only）">
        {stats.recent_events.length === 0 ? (
          <EmptyState text="暂无事件" />
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">客户</th>
                  <th className="th">事件</th>
                  <th className="th">状态变化</th>
                  <th className="th">触发</th>
                  <th className="th">时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {stats.recent_events.map((event) => (
                  <tr key={event.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link className="text-brand-700 hover:underline" to={`/customers/${event.customer_id}`}>
                        #{event.customer_id} {event.company_name ?? ''}
                      </Link>
                    </td>
                    <td className="td">{event.event_type}</td>
                    <td className="td">
                      <span className="inline-flex items-center gap-1">
                        <StatusBadge status={event.from_status} />
                        <span className="text-slate-400">→</span>
                        <StatusBadge status={event.to_status} />
                      </span>
                    </td>
                    <td className="td text-xs text-slate-500">{event.trigger}</td>
                    <td className="td text-xs text-slate-500">{formatDateTime(event.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default DashboardPage;
