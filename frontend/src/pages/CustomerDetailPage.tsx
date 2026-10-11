import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAnalyzeReply, useCustomer, useGenerateEmail } from '../api/hooks';
import { REPLY_INTENTS, type ReplyIntent } from '../api/types';
import { IntentBadge, ScoreBadge, StatusArrow, StatusBadge } from '../components/Badges';
import { Card, EmptyState, ErrorBox, JsonBlock, Spinner, Timeline } from '../components/ui';
import { formatCost, formatDateTime, formatNumber, intentLabel } from '../lib/format';

export const CustomerDetailPage = () => {
  const params = useParams<{ id: string }>();
  const customerId = params.id ? Number(params.id) : null;
  const query = useCustomer(customerId);

  const generateEmail = useGenerateEmail();
  const analyzeReply = useAnalyzeReply();

  const [replyText, setReplyText] = useState('');
  const [simulateIntent, setSimulateIntent] = useState<ReplyIntent | ''>('');
  const [expandedEmail, setExpandedEmail] = useState<number | null>(null);

  if (query.isLoading) {
    return (
      <Card title="客户详情">
        <Spinner />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card title="客户详情">
        <ErrorBox error={query.error} />
        <div className="mt-3">
          <Link className="btn-secondary" to="/customers">
            返回客户列表
          </Link>
        </div>
      </Card>
    );
  }

  if (!query.data || customerId === null) {
    return <EmptyState text="客户不存在" />;
  }

  const { customer, emails, replies, timeline, llm_calls: llmCalls, next_action: nextAction, allowed_transitions: allowed } =
    query.data;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link to="/customers" className="text-xs text-brand-600 hover:underline">
            ← 返回客户列表
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">{customer.company_name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-slate-500">
            <StatusBadge status={customer.status} />
            <ScoreBadge score={customer.score} />
            <span>{customer.email}</span>
            {customer.website && (
              <a className="text-brand-600 hover:underline" href={customer.website}>
                {customer.website}
              </a>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link className="btn-secondary" to={`/workflow?customer=${customer.id}`}>
            ⚡ 运行工作流
          </Link>
          <button
            className="btn-primary"
            disabled={generateEmail.isPending}
            onClick={() => generateEmail.mutate({ customerId: customer.id, send: true })}
          >
            {generateEmail.isPending ? '生成中…' : '✉️ 生成开发信并发送'}
          </button>
        </div>
      </div>

      {generateEmail.isError && <ErrorBox title="生成邮件失败" error={generateEmail.error} />}
      {generateEmail.isSuccess && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
          <div className="font-semibold">邮件已生成（状态 {generateEmail.data.from_status} → {generateEmail.data.to_status}）</div>
          <div className="mt-1">主题：{generateEmail.data.subject}</div>
          <div className="mt-1 text-xs">
            {generateEmail.data.model} · tokens {generateEmail.data.prompt_tokens}/
            {generateEmail.data.completion_tokens} · 耗时 {generateEmail.data.latency_ms}ms · 成本{' '}
            {formatCost(generateEmail.data.cost_usd)} · prompt {generateEmail.data.prompt_version}
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="客户信息" className="lg:col-span-2">
          <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
            {[
              ['联系人', customer.contact_name],
              ['电话', customer.phone],
              ['行业', customer.industry],
              ['国家/地区', customer.country],
              ['团队规模', customer.company_size],
              ['来源', customer.source],
              ['创建时间', formatDateTime(customer.created_at)],
              ['最近触达', formatDateTime(customer.last_contacted_at)],
              ['最近回复', formatDateTime(customer.last_replied_at)],
            ].map(([label, value]) => (
              <div key={String(label)}>
                <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
                <dd className="mt-0.5 text-slate-800">{value || '-'}</dd>
              </div>
            ))}
          </dl>
          {customer.notes && (
            <div className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-600">
              <span className="font-medium text-slate-700">备注：</span>
              {customer.notes}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <span>当前状态允许跳转：</span>
            {allowed.length === 0 && <span className="text-slate-400">无（终态）</span>}
            {allowed.map((value) => (
              <StatusBadge key={value} status={value} />
            ))}
          </div>
        </Card>

        <Card title="下一步建议" subtitle={nextAction ? nextAction.reason : '暂无建议'}>
          {nextAction ? (
            <div className="space-y-3 text-sm">
              <div className="rounded-lg border border-brand-200 bg-brand-50 p-3 font-medium text-brand-800">
                {nextAction.action}
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                  优先级：{nextAction.priority}
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5">
                  {nextAction.due_in_days} 天内
                </span>
              </div>
              <ul className="list-inside list-disc space-y-1 text-slate-600">
                {nextAction.playbook.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </div>
          ) : (
            <EmptyState text="暂无建议" />
          )}

          <div className="mt-5 border-t border-slate-200 pt-4">
            <div className="label">手动分析客户回复</div>
            <textarea
              className="input h-24"
              placeholder="粘贴客户回复内容；留空则自动生成模拟回复"
              value={replyText}
              onChange={(event) => setReplyText(event.target.value)}
            />
            <div className="mt-2 flex items-center gap-2">
              <select
                className="input"
                value={simulateIntent}
                onChange={(event) => setSimulateIntent(event.target.value as ReplyIntent | '')}
              >
                <option value="">模拟意图：自动</option>
                {REPLY_INTENTS.map((intent) => (
                  <option key={intent} value={intent}>
                    {intentLabel(intent)}
                  </option>
                ))}
              </select>
              <button
                className="btn-primary whitespace-nowrap"
                disabled={analyzeReply.isPending}
                onClick={() =>
                  analyzeReply.mutate({
                    customerId: customer.id,
                    body: replyText.trim() || undefined,
                    simulate: replyText.trim().length === 0,
                    intent: simulateIntent || undefined,
                  })
                }
              >
                {analyzeReply.isPending ? '分析中…' : '🔍 分析并更新状态'}
              </button>
            </div>
            {analyzeReply.isError && (
              <div className="mt-2">
                <ErrorBox title="分析失败" error={analyzeReply.error} />
              </div>
            )}
            {analyzeReply.isSuccess && (
              <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
                <div className="text-sm font-semibold">
                  意图：{intentLabel(analyzeReply.data.classification.intent)}（置信度{' '}
                  {analyzeReply.data.classification.confidence}）
                </div>
                <div className="mt-1">
                  状态：{analyzeReply.data.from_status} → {analyzeReply.data.to_status}
                  {analyzeReply.data.status_change_error && (
                    <span className="ml-1 text-amber-700">（{analyzeReply.data.status_change_error}）</span>
                  )}
                </div>
                <div className="mt-1">摘要：{analyzeReply.data.classification.summary}</div>
                <div className="mt-1">
                  建议动作：{analyzeReply.data.classification.suggested_action} · 耗时{' '}
                  {analyzeReply.data.latency_ms}ms · tokens {analyzeReply.data.prompt_tokens}/
                  {analyzeReply.data.completion_tokens}
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card title={`邮件记录（${emails.length}）`} subtitle="点击展开正文；含模型、token 与耗时">
        {emails.length === 0 ? (
          <EmptyState text="暂无邮件记录，点击右上角“生成开发信并发送”" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {emails.map((email) => (
              <li key={email.id} className="py-3">
                <button
                  className="flex w-full flex-wrap items-center justify-between gap-2 text-left"
                  onClick={() => setExpandedEmail(expandedEmail === email.id ? null : email.id)}
                >
                  <div>
                    <div className="text-sm font-medium text-slate-800">{email.subject}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      #{email.id} · {email.status} · {formatDateTime(email.created_at)} · {email.model ?? '-'} ·
                      tokens {email.prompt_tokens}/{email.completion_tokens} · {email.latency_ms}ms
                      {email.mock && <span className="ml-1 text-amber-600">mock</span>}
                    </div>
                  </div>
                  <span className="text-xs text-brand-600">{expandedEmail === email.id ? '收起' : '展开'}</span>
                </button>
                {expandedEmail === email.id && (
                  <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                    {email.body}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`回复记录（${replies.length}）`}>
        {replies.length === 0 ? (
          <EmptyState text="暂无客户回复" />
        ) : (
          <ul className="divide-y divide-slate-100">
            {replies.map((reply) => (
              <li key={reply.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <IntentBadge intent={reply.intent} />
                  <span className="text-xs text-slate-500">
                    置信度 {reply.confidence ?? '-'} · {reply.model ?? '-'} · tokens {reply.prompt_tokens}/
                    {reply.completion_tokens} · {reply.latency_ms}ms · {formatDateTime(reply.created_at)}
                  </span>
                  {reply.needs_human && (
                    <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
                      需人工介入
                    </span>
                  )}
                </div>
                <div className="mt-1">
                  <StatusArrow from={reply.from_status} to={reply.to_status} />
                </div>
                {reply.summary && <div className="mt-1 text-xs text-slate-500">摘要：{reply.summary}</div>}
                {reply.suggested_action && (
                  <div className="mt-0.5 text-xs text-slate-500">建议：{reply.suggested_action}</div>
                )}
                <pre className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
                  {reply.body}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="状态变更时间线" subtitle="events 表（append-only）">
          <Timeline events={timeline} />
        </Card>

        <Card title={`LLM 调用（${llmCalls.length}）`} subtitle="每次调用的模型、token、耗时与成本">
          {llmCalls.length === 0 ? (
            <EmptyState text="暂无 LLM 调用记录" />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="th">操作</th>
                    <th className="th">模型</th>
                    <th className="th">tokens</th>
                    <th className="th">耗时</th>
                    <th className="th">成本</th>
                    <th className="th">时间</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {llmCalls.map((call) => (
                    <tr key={call.id}>
                      <td className="td">
                        {call.operation}
                        {call.mock && <span className="ml-1 text-xs text-amber-600">mock</span>}
                      </td>
                      <td className="td">{call.model}</td>
                      <td className="td">
                        {formatNumber(call.prompt_tokens)}/{formatNumber(call.completion_tokens)}
                      </td>
                      <td className="td">{call.latency_ms}ms</td>
                      <td className="td">{formatCost(call.cost_usd)}</td>
                      <td className="td text-xs text-slate-500">{formatDateTime(call.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="原始事件（调试用）" subtitle="包含 payload，便于排查状态流转">
        <JsonBlock value={query.data.events.slice(-10)} />
      </Card>
    </div>
  );
};

export default CustomerDetailPage;
