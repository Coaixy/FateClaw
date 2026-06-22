import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUserByAccountId, mockGetUserById } = vi.hoisted(() => ({
  mockGetUserByAccountId: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock('../../src/infrastructure/db.js', () => ({
  getUserByAccountId: mockGetUserByAccountId,
  getUserById: mockGetUserById,
}));

vi.mock('../../src/modules/chat/web-chat-runtime.js', () => ({
  getUserIdFromWebChatRuntimeId: vi.fn(() => null),
}));

vi.mock('../../src/infrastructure/repositories/config-repository.js', () => ({
  getRuntimeConfig: vi.fn(async () => ({
    agent_request_timeout_ms: 1_800_000,
    agent_account_concurrency: 1,
  })),
}));

import {
  agentEnvToRecord,
  buildAgentEnv,
} from '../../src/runtime/agent-env.js';

describe('buildAgentEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserByAccountId.mockResolvedValue({ id: 'user-1' });
    mockGetUserById.mockResolvedValue({ id: 'user-1' });
  });

  it('does not inject model provider credentials into agent env', async () => {
    const env = agentEnvToRecord(await buildAgentEnv('account-1'));

    expect(env).not.toHaveProperty('AGENT_MODEL');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
    expect(env).not.toHaveProperty('XUAN_API_KEY');
    expect(env).not.toHaveProperty('XUAN_MODEL');
    expect(env).not.toHaveProperty('XUAN_BASE_URL');
  });
});
