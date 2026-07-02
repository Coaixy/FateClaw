import { describe, expect, it, vi } from 'vitest';

// 纯函数测试：mock 掉 db/redis，隔离 import 链的任何副作用，只验证构造逻辑。
vi.mock('../../src/infrastructure/db.js', () => ({
  getSingleAccountIdIfOnlyOne: vi.fn(),
}));
vi.mock('../../src/infrastructure/redis.js', () => ({
  getRedis: vi.fn(),
}));

import {
  buildAiChatErrorResponsePayload,
  validateResponsePayload,
} from '../../src/runtime/ipc-payloads.js';

describe('buildAiChatErrorResponsePayload', () => {
  it('产出的 error payload 必含 text 且能通过 validateResponsePayload', () => {
    // 回归：三处失败兜底（进程崩溃/提交失败/inbox 堆积超时）曾各自手工拼装 payload、
    // 漏掉必填的 text，导致 validateResponsePayload 判无效、兜底静默失效、用户卡在
    // 「正在回复」。统一构造函数必须保证 text 兜底为 publicErrorText，堵住这一整类漏字段。
    const payload = buildAiChatErrorResponsePayload({
      accountId: 'web:acct-1',
      requestId: 'aichat-1-abc',
      sessionId: 'session-1',
      publicErrorText: '抱歉，AI 服务暂时不可用',
      error: '内部诊断细节：exit code 137 OOM',
      reasonCode: 'submit_error',
    });

    expect(validateResponsePayload(payload)).toBe(true);
    expect(payload.text).toBe('抱歉，AI 服务暂时不可用');
    expect(payload.status).toBe('error');
    expect(payload.publicReasonCode).toBe('submit_error');
    // 内部诊断信息只进 error 字段，不外泄到面向用户的 text。
    expect(payload.error).toContain('137');
    expect(payload.text).not.toContain('137');
  });

  it('省略可选字段时仍产出合法 payload（text 兜底不缺失）', () => {
    const payload = buildAiChatErrorResponsePayload({
      accountId: 'web:acct-2',
      requestId: 'aichat-2-def',
      publicErrorText: '处理超时，请重新发送',
      error: 'inbox stall timeout',
      reasonCode: 'inbox_stall_timeout',
    });

    expect(validateResponsePayload(payload)).toBe(true);
    expect(payload.text).toBe('处理超时，请重新发送');
    expect(payload.sessionId).toBeUndefined();
    expect(payload.usage).toBeUndefined();
  });
});
