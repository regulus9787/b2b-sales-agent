import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCustomers } from '../api/hooks';
import { CUSTOMER_STATUSES, STATUS_LABELS, type CustomerStatus } from '../api/types';
import { IntentBadge, ScoreBadge, StatusBadge } from '../components/Badges';
import { Card, EmptyState, ErrorBox, Spinner } from '../components/ui';
import { formatDateTime, formatRelative } from '../lib/format';

const PAGE_SIZE = 10;

export const CustomersPage = () => {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<CustomerStatus | ''>('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<'created_at' | 'updated_at' | 'score' | 'company_name'>(
    'created_at',
  );
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  // 输入防抖：400ms 后再发请求
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const params = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      ...(status ? { status } : {}),
      ...(search ? { search } : {}),
      sortBy,
      sortOrder,
    }),
    [page, status, search, sortBy, sortOrder],
  );

  const query = useCustomers(params);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">客户列表</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            支持状态过滤、公司与邮箱搜索、分页；点击公司名进入详情，查看邮件、回复与状态时间线。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input w-64"
            placeholder="搜索公司 / 邮箱 / 联系人 / 行业"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <select
            className="input w-40"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as CustomerStatus | '');
              setPage(1);
            }}
          >
            <option value="">全部状态</option>
            {CUSTOMER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}（{value}）
              </option>
            ))}
          </select>
          <select
            className="input w-40"
            value={`${sortBy}:${sortOrder}`}
            onChange={(event) => {
              const [nextSortBy, nextSortOrder] = event.target.value.split(':');
              setSortBy(nextSortBy as typeof sortBy);
              setSortOrder(nextSortOrder as 'asc' | 'desc');
            }}
          >
            <option value="created_at:desc">最新创建</option>
            <option value="updated_at:desc">最近更新</option>
            <option value="score:desc">评分最高</option>
            <option value="company_name:asc">公司名 A→Z</option>
          </select>
        </div>
      </div>

      <Card
        title={`共 ${query.data?.pagination.total ?? 0} 个客户`}
        subtitle={
          query.data
            ? `第 ${query.data.pagination.page} / ${query.data.pagination.totalPages || 1} 页 · 每页 ${PAGE_SIZE} 条`
            : undefined
        }
      >
        {query.isLoading && <Spinner />}
        {query.isError && <ErrorBox error={query.error} />}
        {query.data && query.data.items.length === 0 && <EmptyState text="没有符合条件的客户" />}

        {query.data && query.data.items.length > 0 && (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50">
                <tr>
                  <th className="th">公司</th>
                  <th className="th">联系人</th>
                  <th className="th">行业 / 地区</th>
                  <th className="th">状态</th>
                  <th className="th">最近意图</th>
                  <th className="th">评分</th>
                  <th className="th">邮件 / 回复</th>
                  <th className="th">最近更新</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {query.data.items.map((customer) => (
                  <tr key={customer.id} className="hover:bg-slate-50">
                    <td className="td">
                      <Link
                        to={`/customers/${customer.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {customer.company_name}
                      </Link>
                      <div className="text-xs text-slate-500">{customer.email}</div>
                    </td>
                    <td className="td">
                      {customer.contact_name ?? '-'}
                      <div className="text-xs text-slate-400">{customer.phone ?? ''}</div>
                    </td>
                    <td className="td">
                      {customer.industry ?? '-'}
                      <div className="text-xs text-slate-400">
                        {customer.country ?? '-'} · {customer.company_size ?? '-'}
                      </div>
                    </td>
                    <td className="td">
                      <StatusBadge status={customer.status} />
                    </td>
                    <td className="td">
                      <IntentBadge intent={customer.last_intent} />
                    </td>
                    <td className="td">
                      <ScoreBadge score={customer.score} />
                    </td>
                    <td className="td">
                      {customer.emails_count} / {customer.replies_count}
                    </td>
                    <td className="td" title={formatDateTime(customer.updated_at)}>
                      {formatRelative(customer.updated_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {query.data && query.data.pagination.totalPages > 1 && (
          <div className="mt-4 flex items-center justify-between text-sm">
            <span className="text-slate-500">
              共 {query.data.pagination.total} 条 · 第 {query.data.pagination.page} 页
            </span>
            <div className="flex gap-2">
              <button
                className="btn-secondary"
                disabled={page <= 1}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                上一页
              </button>
              <button
                className="btn-secondary"
                disabled={page >= query.data.pagination.totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
};

export default CustomersPage;
