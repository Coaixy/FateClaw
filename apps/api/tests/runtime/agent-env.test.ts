import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetUserByAccountId, mockGetUserById } = vi.hoisted(() => ({
  mockGetUserByAccountId: vi.fn(),
  mockGetUserById: vi.fn(),
}));

vi.mock('#infrastructure/db', () => ({
  getUserByAccountId: mockGetUserByAccountId,
  getUserById: mockGetUserById,
}));

vi.mock('#modules/chat/web-chat-runtime', () => ({
  getUserIdFromWebChatRuntimeId: vi.fn(() => null),
}));

import { agentEnvToRecord, buildAgentEnv } from '#runtime/agent-env';

describe('buildAgentEnv', () => {
  afterEach(() => vi.unstubAllEnvs());
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

  it('injects both daemon timeout thresholds from the shared timeout chain', async () => {
    const env = agentEnvToRecord(await buildAgentEnv('account-1'));

    expect(env.AGENT_RUNTIME_REQUEST_TIMEOUT_MS).toBe(String(8 * 60 * 1000));
    expect(env.AGENT_RUNTIME_REQUEST_MAX_DURATION_MS).toBe(
      String(25 * 60 * 1000),
    );
  });
  it('forwards the configured Skill cache root through the bounded environment', async () => {
    vi.stubEnv('FATECLAW_TEXT_SKILLS_DIR', '/synthetic/skill-cache');
    const env = agentEnvToRecord(await buildAgentEnv('account-1'));
    expect(env.FATECLAW_TEXT_SKILLS_DIR).toBe('/synthetic/skill-cache');
  });
});
