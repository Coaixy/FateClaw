import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreatedManager, mockOpenedManager, mockSessionManager } =
  vi.hoisted(() => {
    const mockCreatedManager = {
      newSession: vi.fn(),
      isPersisted: vi.fn(() => true),
    };
    const mockOpenedManager = {
      isPersisted: vi.fn(() => true),
    };
    return {
      mockCreatedManager,
      mockOpenedManager,
      mockSessionManager: {
        create: vi.fn(() => mockCreatedManager),
        open: vi.fn(() => mockOpenedManager),
      },
    };
  });

vi.mock('@earendil-works/pi-coding-agent', async () => {
  const actual = await vi.importActual<
    typeof import('@earendil-works/pi-coding-agent')
  >('@earendil-works/pi-coding-agent');
  return {
    ...actual,
    SessionManager: mockSessionManager,
  };
});

import {
  createFateClawPiSessionManager,
  resolvePiSessionFile,
} from '#agent/pi-runtime/session-manager';
import { piSessionStorageKey } from '@fateclaw/contracts/agent/session';

describe('createFateClawPiSessionManager', () => {
  beforeEach(() => {
    delete process.env.FATECLAW_PI_SESSION_DIR;
    mockCreatedManager.newSession.mockReset();
    mockCreatedManager.isPersisted.mockReset();
    mockCreatedManager.isPersisted.mockReturnValue(true);
    mockOpenedManager.isPersisted.mockReset();
    mockOpenedManager.isPersisted.mockReturnValue(true);
    mockSessionManager.create.mockClear();
    mockSessionManager.open.mockClear();
  });

  it('uses the shared audience storage key and never falls back to an owner mapping for a new audience', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-pi-audience-'));
    try {
      const owner = resolvePiSessionFile({
        cwd,
        sessionId: 'business-session',
        contextGeneration: 0,
        contextAudience: '',
      });
      fs.mkdirSync(owner.sessionDir, { recursive: true });
      fs.writeFileSync(owner.mappingFile, 'owner.jsonl');
      fs.writeFileSync(
        path.join(owner.sessionDir, 'owner.jsonl'),
        '{"type":"session","version":3,"id":"business-session"}\n',
      );
      const sender = resolvePiSessionFile({
        cwd,
        sessionId: 'business-session',
        contextGeneration: 0,
        contextAudience: 'sender-a',
      });
      expect(sender.piSessionId).toBe(
        piSessionStorageKey('business-session', 0, 'sender-a'),
      );
      expect(sender.sessionFile).toBeUndefined();
      expect(sender.mappingFile).not.toBe(owner.mappingFile);
      const generated = path.join(
        sender.sessionDir,
        `generated_${sender.piSessionId}.jsonl`,
      );
      mockCreatedManager.newSession.mockReturnValue(generated);
      createFateClawPiSessionManager({
        cwd,
        sessionId: 'business-session',
        contextGeneration: 0,
        contextAudience: 'sender-a',
      });
      expect(mockSessionManager.open).not.toHaveBeenCalled();
      expect(mockCreatedManager.newSession).toHaveBeenCalledWith({
        id: sender.piSessionId,
      });
      expect(fs.readFileSync(owner.mappingFile, 'utf8')).toBe('owner.jsonl');
      expect(
        resolvePiSessionFile({
          cwd,
          sessionId: 'business-session',
          contextGeneration: 0,
          contextAudience: 'sender-b',
        }).sessionFile,
      ).toBeUndefined();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('maps a FateClaw chat session id to one stable Pi session file', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-pi-session-'));
    const resolved = resolvePiSessionFile({
      cwd,
      sessionId: 'session:../unsafe id',
    });
    const generatedFile = path.join(resolved.sessionDir, 'generated.jsonl');
    mockCreatedManager.newSession.mockReturnValue(generatedFile);

    const created = createFateClawPiSessionManager({
      cwd,
      sessionId: 'session:../unsafe id',
    });

    expect(resolved.sessionFile).toBeUndefined();
    expect(mockSessionManager.create).toHaveBeenCalledWith(
      cwd,
      resolved.sessionDir,
    );
    expect(mockCreatedManager.newSession).toHaveBeenCalledWith({
      id: 'session_.._unsafe_id',
    });
    expect(created.piSessionId).toBe('session_.._unsafe_id');
    expect(created.sessionFile).toBe(generatedFile);
    expect(fs.readFileSync(resolved.mappingFile, 'utf-8')).toBe(
      'generated.jsonl',
    );
  });

  it('opens the existing Pi session file for the same FateClaw session id', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-pi-session-'));
    const resolved = resolvePiSessionFile({ cwd, sessionId: 'session-1' });
    const sessionFile = path.join(resolved.sessionDir, 'existing.jsonl');
    fs.mkdirSync(resolved.sessionDir, { recursive: true });
    fs.writeFileSync(resolved.mappingFile, path.basename(sessionFile), 'utf-8');
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'session-1',
        timestamp: '2026-05-27T00:00:00.000Z',
        cwd,
      }) + '\n',
    );

    createFateClawPiSessionManager({ cwd, sessionId: 'session-1' });

    expect(mockSessionManager.open).toHaveBeenCalledWith(
      sessionFile,
      resolved.sessionDir,
      cwd,
    );
  });
});
