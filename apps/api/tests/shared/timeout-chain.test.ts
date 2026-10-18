/**
 * 超时链单一事实源的不变式测试。
 *
 * 锁定两件事：
 * 1. 默认配置下派生值满足时序不变式（daemon 停滞阈值 < daemon 绝对上限 <
 *    inbox 清理阈值 < API 超时 < 锁 TTL）；
 * 2. 违例配置（daemon 绝对上限 ≥ API 超时）在模块加载时快速失败。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFreshTimeoutChain() {
  vi.resetModules();
  return import('#shared/timeout-chain');
}

describe('timeout-chain', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('默认值满足时序不变式', async () => {
    vi.stubEnv('AGENT_RUNTIME_REQUEST_TIMEOUT_MS', '');
    vi.stubEnv('AGENT_REQUEST_TIMEOUT', '');
    vi.stubEnv('AI_CHAT_REQUEST_TIMEOUT', '');
    const chain = await importFreshTimeoutChain();

    expect(chain.AGENT_RUNTIME_REQUEST_TIMEOUT_MS).toBeLessThan(
      chain.AGENT_RUNTIME_REQUEST_MAX_DURATION_MS,
    );
    expect(chain.AGENT_RUNTIME_REQUEST_MAX_DURATION_MS).toBeLessThan(
      chain.INBOX_STALL_FAIL_MS,
    );
    expect(chain.INBOX_STALL_FAIL_MS).toBeLessThan(chain.MAX_REQUEST_TIMEOUT_MS);
    expect(chain.SESSION_PROCESSING_LOCK_TTL_SECONDS * 1000).toBeGreaterThan(
      chain.MAX_REQUEST_TIMEOUT_MS,
    );
    expect(chain.INBOX_STALL_WARN_MS).toBeLessThan(chain.INBOX_STALL_FAIL_MS);
  });

  it('调大 daemon 绝对上限后，inbox 清理阈值自动跟随（保持余量）', async () => {
    vi.stubEnv('AGENT_RUNTIME_REQUEST_TIMEOUT_MS', String(8 * 60 * 1000));
    vi.stubEnv(
      'AGENT_RUNTIME_REQUEST_MAX_DURATION_MS',
      String(20 * 60 * 1000),
    );
    const chain = await importFreshTimeoutChain();

    expect(chain.AGENT_RUNTIME_REQUEST_MAX_DURATION_MS).toBe(
      20 * 60 * 1000,
    );
    expect(chain.INBOX_STALL_FAIL_MS).toBe(22 * 60 * 1000);
  });

  it('daemon 绝对上限被配得不小于 API 超时时，模块加载直接抛错', async () => {
    vi.stubEnv('AGENT_RUNTIME_REQUEST_TIMEOUT_MS', String(8 * 60 * 1000));
    vi.stubEnv(
      'AGENT_RUNTIME_REQUEST_MAX_DURATION_MS',
      String(30 * 60 * 1000),
    );
    vi.stubEnv('AGENT_REQUEST_TIMEOUT', String(10 * 60 * 1000));

    await expect(importFreshTimeoutChain()).rejects.toThrow('超时链配置违例');
  });

  it('非法 env 值回退默认而不是 NaN 污染整条链', async () => {
    vi.stubEnv('AGENT_RUNTIME_REQUEST_TIMEOUT_MS', 'not-a-number');
    vi.stubEnv('AGENT_RUNTIME_REQUEST_MAX_DURATION_MS', 'not-a-number');
    vi.stubEnv('AI_CHAT_REQUEST_TIMEOUT', '-5');
    const chain = await importFreshTimeoutChain();

    expect(chain.AGENT_RUNTIME_REQUEST_TIMEOUT_MS).toBe(8 * 60 * 1000);
    expect(chain.AGENT_RUNTIME_REQUEST_MAX_DURATION_MS).toBe(25 * 60 * 1000);
    expect(chain.AI_CHAT_REQUEST_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });
});
