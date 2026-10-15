import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSyntheticSourceInfo,
  type Skill,
} from '@earendil-works/pi-coding-agent';

import { createPiSkillGrepTool } from '../src/pi-runtime/tools/skill-grep-tool.js';
import { SKILL_GREP_TIMEOUT_MS } from '../src/pi-runtime/tools/skill-grep-protocol.js';
import { createRequestScope } from '../src/request-scope.js';

const directories: string[] = [];

function fixture() {
  const baseDir = mkdtempSync(path.join(os.tmpdir(), 'fateclaw-grep-worker-'));
  directories.push(baseDir);
  const filePath = path.join(baseDir, 'SKILL.md');
  writeFileSync(filePath, '# Synthetic knowledge\n');
  writeFileSync(path.join(baseDir, 'payload.md'), `${'a'.repeat(3000)}!`);
  const skill: Skill = {
    name: 'synthetic',
    description: 'Synthetic knowledge',
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, {
      source: 'test',
      baseDir,
    }),
    disableModelInvocation: false,
  };
  const recordExecution = vi.fn();
  const requestScope = createRequestScope();
  const tool = createPiSkillGrepTool({
    readableSkills: [skill],
    requestScope,
    recordExecution,
  });
  return { tool, recordExecution, requestScope, baseDir };
}

async function probe(mode: 'timeout' | 'cancel') {
  const { baseDir } = fixture();
  const toolUrl = new URL(
    '../src/pi-runtime/tools/skill-grep-tool.ts',
    import.meta.url,
  ).href;
  const scopeUrl = new URL('../src/request-scope.ts', import.meta.url).href;
  const apiRequire = createRequire(
    new URL('../../api/package.json', import.meta.url),
  );
  // Keep the watchdog outside the process under test so a regression cannot hang the suite.
  const source = `
    import assert from 'node:assert/strict';
    import { createPiSkillGrepTool } from ${JSON.stringify(toolUrl)};
    import { createRequestScope } from ${JSON.stringify(scopeUrl)};
    const scope = createRequestScope();
    let records = 0;
    let ticks = 0;
    const tool = createPiSkillGrepTool({
      readableSkills: [{name:'synthetic',baseDir:${JSON.stringify(baseDir)}}],
      requestScope: scope,
      recordExecution() { records += 1; },
    });
    const heartbeat = setInterval(() => { ticks += 1; }, 20);
    const controller = new AbortController();
    const cancelTimer = ${JSON.stringify(mode)} === 'cancel' ? setTimeout(() => controller.abort(), 100) : undefined;
    try {
      const result = await tool.execute('hostile', {query:'(a+)+$'}, controller.signal);
      assert.ok(ticks > 0);
      assert.equal(records, 1);
      assert.ok(scope.traceEvents.some(event => event.type === 'pi_skill_grep_completed' && event.errorCode === result.details.errorCode));
      const next = await tool.execute('healthy', {query:'knowledge'});
      assert.equal(next.details.isError, false);
      assert.equal(next.details.total, 1);
      assert.equal(records, 2);
      console.log(JSON.stringify(result.details));
    } finally {
      clearInterval(heartbeat);
      clearTimeout(cancelTimer);
    }
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--import',
      apiRequire.resolve('tsx'),
      '--input-type=module',
      '-e',
      source,
    ],
    { env: {}, timeout: SKILL_GREP_TIMEOUT_MS + 5_000, killSignal: 'SIGKILL' },
  );
  return JSON.parse(stdout);
}

afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe('isolated skill grep', () => {
  it(
    'terminates catastrophic backtracking while the daemon stays responsive and can search again',
    async () => {
      const result = await probe('timeout');
      expect(result).toMatchObject({
        isError: true,
        errorCode: 'skill_grep_timeout',
        totalIsExact: false,
        truncated: true,
      });
    },
    SKILL_GREP_TIMEOUT_MS + 8_000,
  );

  it(
    'cancels a running search and records its terminal result once',
    async () => {
      const result = await probe('cancel');
      expect(result).toMatchObject({
        isError: true,
        errorCode: 'skill_grep_cancelled',
      });
    },
    SKILL_GREP_TIMEOUT_MS + 8_000,
  );

  it('honors a signal cancelled before the tool starts', async () => {
    const { tool } = fixture();
    const controller = new AbortController();
    controller.abort();
    const result = await tool.execute(
      'cancelled',
      { query: 'knowledge' },
      controller.signal,
      undefined,
      undefined as never,
    );
    expect(result.details).toMatchObject({
      isError: true,
      errorCode: 'skill_grep_cancelled',
    });
  });
});
