import type { ReactNode } from 'react';
import type { SalesEvent } from '../api/types';
import { StatusBadge } from './Badges';
import { eventLabel, formatDateTime } from '../lib/format';

export const Card = ({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) => (
  <section className={`card ${className}`}>
    {(title || actions) && (
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
          {subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
    )}
    {children}
  </section>
);

export const StatCard = ({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'brand' | 'success' | 'warn' | 'danger';
}) => {
  const tones: Record<string, string> = {
    default: 'border-slate-200 bg-white',
    brand: 'border-brand-200 bg-brand-50',
    success: 'border-emerald-200 bg-emerald-50',
    warn: 'border-amber-200 bg-amber-50',
    danger: 'border-rose-200 bg-rose-50',
  };
  return (
    <div className={`rounded-xl border p-4 shadow-sm ${tones[tone]}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
};

export const Spinner = ({ label = '加载中…' }: { label?: string }) => (
  <div className="flex items-center gap-2 py-6 text-sm text-slate-500">
    <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
    {label}
  </div>
);

export const ErrorBox = ({ title = '请求失败', error }: { title?: string; error: unknown }) => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">
      <div className="font-semibold">{title}</div>
      <div className="mt-1 break-words">{message}</div>
    </div>
  );
};

export const EmptyState = ({ text }: { text: string }) => (
  <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
    {text}
  </div>
);

export const JsonBlock = ({ value }: { value: unknown }) => (
  <pre className="max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
    {JSON.stringify(value, null, 2)}
  </pre>
);

export const Timeline = ({ events }: { events: SalesEvent[] }) => {
  if (events.length === 0) {
    return <EmptyState text="暂无状态变更记录" />;
  }
  return (
    <ol className="relative ml-3 border-l border-slate-200">
      {events
        .slice()
        .reverse()
        .map((event) => (
          <li key={event.id} className="mb-5 ml-5">
            <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white bg-brand-500" />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-slate-800">{eventLabel(event.event_type)}</span>
              {(event.from_status || event.to_status) && (
                <span className="inline-flex items-center gap-1 text-xs">
                  <StatusBadge status={event.from_status} />
                  <span className="text-slate-400">→</span>
                  <StatusBadge status={event.to_status} />
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
              <span>触发：{event.trigger}</span>
              <span>actor：{event.actor}</span>
              <span>{formatDateTime(event.created_at)}</span>
              {event.run_id && <span className="font-mono">run: {event.run_id.slice(0, 8)}</span>}
            </div>
          </li>
        ))}
    </ol>
  );
};
