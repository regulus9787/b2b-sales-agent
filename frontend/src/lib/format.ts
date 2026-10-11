/**
 * 展示用工具函数
 */
import type { CustomerStatus, ReplyIntent } from '../api/types';
import { STATUS_LABELS, INTENT_LABELS } from '../api/types';

/** ISO 时间 → 本地可读时间 */
export const formatDateTime = (value: string | null | undefined): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
};

export const formatRelative = (value: string | null | undefined): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatDateTime(value);
};

export const formatNumber = (value: number | null | undefined): string =>
  value === null || value === undefined ? '-' : value.toLocaleString('zh-CN');

/** 成本展示：小于 1 美分时保留更多小数 */
export const formatCost = (value: number): string => {
  if (value === 0) return '$0.000000';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
};

export const statusLabel = (status: CustomerStatus | string | null): string => {
  if (!status) return '-';
  return STATUS_LABELS[status as CustomerStatus] ?? String(status);
};

export const intentLabel = (intent: ReplyIntent | string | null): string => {
  if (!intent) return '-';
  return INTENT_LABELS[intent as ReplyIntent] ?? String(intent);
};

export const STATUS_STYLES: Record<CustomerStatus, string> = {
  new: 'bg-slate-100 text-slate-700 border-slate-200',
  enriched: 'bg-sky-100 text-sky-700 border-sky-200',
  email_drafted: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  contacted: 'bg-blue-100 text-blue-700 border-blue-200',
  replied: 'bg-violet-100 text-violet-700 border-violet-200',
  interested: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  needs_info: 'bg-amber-100 text-amber-700 border-amber-200',
  rejected: 'bg-rose-100 text-rose-700 border-rose-200',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
  meeting_booked: 'bg-teal-100 text-teal-700 border-teal-200',
  closed: 'bg-zinc-200 text-zinc-700 border-zinc-300',
};

export const INTENT_STYLES: Record<ReplyIntent, string> = {
  interested: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  needs_info: 'bg-amber-100 text-amber-700 border-amber-200',
  rejected: 'bg-rose-100 text-rose-700 border-rose-200',
  neutral: 'bg-slate-100 text-slate-600 border-slate-200',
};

export const EVENT_TYPE_LABELS: Record<string, string> = {
  lead_imported: '线索导入',
  lead_scored: '线索评分',
  status_changed: '状态变更',
  email_generated: '邮件生成',
  email_sent: '邮件发送',
  reply_received: '收到回复',
  reply_classified: '意图分类',
  agent_run_started: 'Agent 启动',
  agent_run_finished: 'Agent 完成',
  note_added: '备注',
};

export const eventLabel = (type: string): string => EVENT_TYPE_LABELS[type] ?? type;
