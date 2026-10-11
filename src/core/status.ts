/**
 * 客户状态机（AGENTS.md 第 4 节）
 *
 *   new → enriched → email_drafted → contacted → replied
 *   replied → interested | needs_info | rejected | neutral
 *   interested → meeting_booked → closed
 *
 * 非法跳转 → HTTP 409 + INVALID_STATUS_TRANSITION
 */
import { z } from 'zod';
import { invalidStatusTransition } from './errors';

export const CUSTOMER_STATUSES = [
  'new',
  'enriched',
  'email_drafted',
  'contacted',
  'replied',
  'interested',
  'needs_info',
  'rejected',
  'neutral',
  'meeting_booked',
  'closed',
] as const;

export const customerStatusSchema = z.enum(CUSTOMER_STATUSES);
export type CustomerStatus = z.infer<typeof customerStatusSchema>;

/** 客户回复意图（= 回复后可能的四种状态） */
export const REPLY_INTENTS = ['interested', 'needs_info', 'rejected', 'neutral'] as const;
export const replyIntentSchema = z.enum(REPLY_INTENTS);
export type ReplyIntent = z.infer<typeof replyIntentSchema>;

/** 状态机允许的边（唯一事实来源：校验、文档、前端都读这里） */
export const STATUS_TRANSITIONS: Record<CustomerStatus, readonly CustomerStatus[]> = {
  new: ['enriched'],
  enriched: ['email_drafted'],
  email_drafted: ['contacted', 'email_drafted'],
  contacted: ['replied', 'contacted'],
  replied: ['interested', 'needs_info', 'rejected', 'neutral', 'replied'],
  interested: ['meeting_booked', 'closed', 'interested', 'needs_info'],
  needs_info: ['contacted', 'interested', 'rejected', 'neutral', 'closed', 'needs_info'],
  rejected: ['closed', 'rejected'],
  neutral: ['contacted', 'interested', 'meeting_booked', 'closed', 'neutral'],
  meeting_booked: ['closed', 'meeting_booked'],
  closed: ['closed'],
};

/** 终态：不允许再往外跳（自环除外，自环用于幂等写入） */
export const TERMINAL_STATUSES: readonly CustomerStatus[] = ['closed', 'rejected'];

export const isCustomerStatus = (value: unknown): value is CustomerStatus =>
  typeof value === 'string' && (CUSTOMER_STATUSES as readonly string[]).includes(value);

export const isReplyIntent = (value: unknown): value is ReplyIntent =>
  typeof value === 'string' && (REPLY_INTENTS as readonly string[]).includes(value);

/** 目标状态是否可达 */
export const canTransition = (from: CustomerStatus, to: CustomerStatus): boolean =>
  STATUS_TRANSITIONS[from].includes(to);

export const allowedTransitions = (from: CustomerStatus): readonly CustomerStatus[] =>
  STATUS_TRANSITIONS[from];

/** 自环表示幂等（例如重复标记 contacted）；不算错误 */
export const isSelfTransition = (from: CustomerStatus, to: CustomerStatus): boolean => from === to;

/**
 * 断言状态跳转合法，非法时抛 AppError(INVALID_STATUS_TRANSITION, 409)
 */
export const assertTransition = (from: CustomerStatus, to: CustomerStatus): void => {
  if (isSelfTransition(from, to)) return;
  if (!canTransition(from, to)) {
    const reason = TERMINAL_STATUSES.includes(from)
      ? `状态 ${from} 为终态，不允许再变更`
      : `允许的目标状态: ${STATUS_TRANSITIONS[from].join(', ')}`;
    throw invalidStatusTransition(from, to, reason);
  }
};

/** 意图 → 下一状态（分类结果落地时使用） */
export const intentToStatus = (intent: ReplyIntent): CustomerStatus => intent;

/** 状态中文标签（前端展示 / 日志可读性） */
export const STATUS_LABELS: Record<CustomerStatus, string> = {
  new: '新线索',
  enriched: '已补全',
  email_drafted: '邮件已起草',
  contacted: '已触达',
  replied: '已回复',
  interested: '有意向',
  needs_info: '需更多信息',
  rejected: '已拒绝',
  neutral: '中性',
  meeting_booked: '已约会议',
  closed: '已关闭',
};

export interface StatusMachineSnapshot {
  statuses: readonly CustomerStatus[];
  transitions: Record<CustomerStatus, readonly CustomerStatus[]>;
  terminal: readonly CustomerStatus[];
  labels: Record<CustomerStatus, string>;
}

/** 给前端/文档暴露状态机全貌 */
export const describeStatusMachine = (): StatusMachineSnapshot => ({
  statuses: CUSTOMER_STATUSES,
  transitions: STATUS_TRANSITIONS,
  terminal: TERMINAL_STATUSES,
  labels: STATUS_LABELS,
});
