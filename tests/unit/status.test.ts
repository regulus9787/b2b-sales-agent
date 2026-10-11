/**
 * 单元测试：客户状态机（src/core/status.ts）
 */
import { describe, expect, it } from 'vitest';
import {
  CUSTOMER_STATUSES,
  STATUS_TRANSITIONS,
  allowedTransitions,
  assertTransition,
  canTransition,
  describeStatusMachine,
  intentToStatus,
  isCustomerStatus,
  isReplyIntent,
  isSelfTransition,
  replyIntentSchema,
} from '../../src/core/status';
import { AppError, ErrorCode } from '../../src/core/errors';

describe('core/status 状态机', () => {
  it('包含规范要求的全部状态', () => {
    for (const status of [
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
    ]) {
      expect(CUSTOMER_STATUSES).toContain(status);
    }
  });

  it('主链路 new → enriched → email_drafted → contacted → replied 全部可达', () => {
    expect(canTransition('new', 'enriched')).toBe(true);
    expect(canTransition('enriched', 'email_drafted')).toBe(true);
    expect(canTransition('email_drafted', 'contacted')).toBe(true);
    expect(canTransition('contacted', 'replied')).toBe(true);
  });

  it('replied 可跳转到四种意图状态', () => {
    for (const intent of ['interested', 'needs_info', 'rejected', 'neutral']) {
      expect(canTransition('replied', intent as never)).toBe(true);
    }
  });

  it('interested → meeting_booked → closed', () => {
    expect(canTransition('interested', 'meeting_booked')).toBe(true);
    expect(canTransition('meeting_booked', 'closed')).toBe(true);
  });

  it('非法跳转（new → closed）被拒绝', () => {
    expect(canTransition('new', 'closed')).toBe(false);
    expect(() => assertTransition('new', 'closed')).toThrowError(AppError);
  });

  it('非法跳转抛出 INVALID_STATUS_TRANSITION 且 HTTP 409', () => {
    try {
      assertTransition('contacted', 'closed');
      throw new Error('应当抛出异常');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe(ErrorCode.INVALID_STATUS_TRANSITION);
      expect(appError.httpStatus).toBe(409);
      expect(appError.details).toMatchObject({ from_status: 'contacted', to_status: 'closed' });
    }
  });

  it('终态 closed / rejected 不允许再变更（自环除外）', () => {
    expect(() => assertTransition('closed', 'contacted')).toThrowError(AppError);
    expect(() => assertTransition('rejected', 'interested')).toThrowError(AppError);
    expect(() => assertTransition('closed', 'closed')).not.toThrow();
    expect(() => assertTransition('rejected', 'rejected')).not.toThrow();
  });

  it('自环视为幂等', () => {
    expect(isSelfTransition('contacted', 'contacted')).toBe(true);
    expect(isSelfTransition('contacted', 'replied')).toBe(false);
  });

  it('allowedTransitions 返回目标状态列表', () => {
    expect(allowedTransitions('new')).toEqual(['enriched']);
    expect(allowedTransitions('replied')).toContain('interested');
  });

  it('类型守卫与 Zod schema 一致', () => {
    expect(isCustomerStatus('interested')).toBe(true);
    expect(isCustomerStatus('unknown')).toBe(false);
    expect(isReplyIntent('needs_info')).toBe(true);
    expect(isReplyIntent('closed')).toBe(false);
    expect(replyIntentSchema.safeParse('rejected').success).toBe(true);
    expect(replyIntentSchema.safeParse('new').success).toBe(false);
  });

  it('intentToStatus 返回同名状态', () => {
    expect(intentToStatus('interested')).toBe('interested');
  });

  it('describeStatusMachine 输出状态机全貌', () => {
    const snapshot = describeStatusMachine();
    expect(snapshot.statuses.length).toBe(CUSTOMER_STATUSES.length);
    expect(snapshot.transitions).toEqual(STATUS_TRANSITIONS);
    expect(snapshot.terminal).toContain('closed');
    expect(snapshot.labels.interested).toBe('有意向');
  });
});
