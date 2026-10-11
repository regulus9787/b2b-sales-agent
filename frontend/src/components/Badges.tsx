import type { CustomerStatus, ReplyIntent } from '../api/types';
import { INTENT_STYLES, STATUS_STYLES, intentLabel, statusLabel } from '../lib/format';

export const StatusBadge = ({ status }: { status: CustomerStatus | string | null }) => {
  if (!status) return <span className="text-xs text-slate-400">-</span>;
  const style = STATUS_STYLES[status as CustomerStatus] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      {statusLabel(status)}
    </span>
  );
};

export const IntentBadge = ({ intent }: { intent: ReplyIntent | string | null }) => {
  if (!intent) return <span className="text-xs text-slate-400">未分类</span>;
  const style = INTENT_STYLES[intent as ReplyIntent] ?? 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}>
      {intentLabel(intent)}
    </span>
  );
};

export const ScoreBadge = ({ score }: { score: number }) => {
  const style =
    score >= 80
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : score >= 65
        ? 'bg-sky-50 text-sky-700 border-sky-200'
        : score >= 45
          ? 'bg-amber-50 text-amber-700 border-amber-200'
          : 'bg-slate-50 text-slate-600 border-slate-200';
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${style}`}>
      {score}
    </span>
  );
};

export const StatusArrow = ({ from, to }: { from: string | null; to: string | null }) => (
  <span className="inline-flex items-center gap-1 text-xs text-slate-500">
    <StatusBadge status={from} />
    <span className="text-slate-400">→</span>
    <StatusBadge status={to} />
  </span>
);

export default StatusBadge;
