import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, expect, it } from 'vitest';

let root;

function write(filename, contents) {
  const target = path.join(root, filename);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-pack-test-'));
  write('package.json', JSON.stringify({ name: 'fateclaw', version: '1.0.0' }));
  write('pnpm-workspace.yaml', 'packages: []\n');
  write('patches/example.patch', 'fixture');
  write('scripts/pack.sh', fs.readFileSync(new URL('../scripts/pack.sh', import.meta.url)));
  write('scripts/write-release-notices.mjs', `
    import fs from 'node:fs';
    for (const file of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt']) {
      fs.writeFileSync(process.argv[3] + '/' + file, 'fixture notice');
    }
  `);
  for (const app of ['api', 'agent-runtime']) {
    write(`apps/${app}/package.json`, JSON.stringify({
      dependencies: { '@fateclaw/contracts': 'workspace:*' },
    }));
  }
  write('packages/contracts/package.json', JSON.stringify({ name: '@fateclaw/contracts' }));
  write('bin/pnpm', `#!/usr/bin/env node
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args[0] === 'config') {
      process.stdout.write(JSON.stringify({ example: '1.0.0' }));
      process.exit(0);
    }
    const events = 'events.jsonl';
    const record = (kind, target) => fs.appendFileSync(events, JSON.stringify({ kind, target, pid: process.pid }) + '\\n');
    const write = (file) => {
      fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
      fs.writeFileSync(file, 'fixture build');
    };
    const build = async (target) => {
      record('start', target);
      if (target === 'contracts' && process.env.PACK_TEST_FAIL === target) {
        console.error('fixture contracts build failed');
        process.exit(17);
      }
      if (target !== 'contracts' && process.env.PACK_TEST_FAIL) {
        if (target === process.env.PACK_TEST_FAIL) {
          while (fs.readFileSync(events, 'utf8').trim().split('\\n').map(JSON.parse).filter(event => event.kind === 'start').length < 4) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          console.error('fixture ' + target + ' build failed');
          process.exit(17);
        }
        await new Promise(resolve => setTimeout(resolve, 30000));
      }
      await new Promise(resolve => setTimeout(resolve, 80));
      if (target === 'contracts') write('packages/contracts/dist/index.js');
      else if (target === 'api' || target === 'agent-runtime') write('apps/' + target + '/dist/index.js');
      else write('apps/' + (target === 'fateclaw-web' ? 'web' : 'admin') + '/out/index.html');
      record('end', target);
    };
    (async () => {
      if (args[0] === '--filter') await build(args[1]);
      else if (args[1] === 'build:contracts') await build('contracts');
      else if (args[1] === 'build:api') await build('api');
      else if (args[1] === 'build:agent-runtime') await build('agent-runtime');
      else if (args[1] === 'build:backend') {
        await build('contracts'); await build('api'); await build('agent-runtime');
      } else if (args[1] === 'build:www' || args[1] === 'build:admin') {
        await build('contracts');
        await build(args[1] === 'build:www' ? 'fateclaw-web' : 'fateclaw-admin');
      } else throw new Error('Unexpected pnpm invocation: ' + args.join(' '));
    })().catch(error => { console.error(error); process.exit(1); });
  `);
  fs.chmodSync(path.join(root, 'bin/pnpm'), 0o755);
  fs.mkdirSync(path.join(root, 'tmp'));
});

afterEach(() => {
  if (fs.existsSync(path.join(root, 'events.jsonl'))) {
    const lastEventByPid = new Map(events().map(event => [event.pid, event]));
    for (const { pid, kind } of lastEventByPid.values()) {
      if (kind === 'end') continue;
      try { process.kill(pid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

function events() {
  return fs.readFileSync(path.join(root, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
}

function pack(args = [], extraEnv = {}) {
  const result = spawnSync('/bin/bash', ['scripts/pack.sh', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      HOME: root,
      TMPDIR: path.join(root, 'tmp'),
      ...extraEnv,
    },
    timeout: 10000,
  });
  expect(result.error).toBeUndefined();
  return result;
}

function peakConcurrency() {
  let active = 0;
  let peak = 0;
  for (const event of events()) {
    active += event.kind === 'start' ? 1 : -1;
    peak = Math.max(peak, active);
  }
  return peak;
}

it('builds contracts once before parallel targets and preserves runtime and static archives', () => {
  const result = pack();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(events().filter(event => event.kind === 'start' && event.target === 'contracts')).toHaveLength(1);
  expect(events().slice(0, 2).map(({ kind, target }) => [kind, target])).toEqual([
    ['start', 'contracts'], ['end', 'contracts'],
  ]);
  expect(peakConcurrency()).toBe(3);
  expect(result.stdout).not.toMatch(/部署步骤|scp |Nginx:/);
  const destination = path.join(root, 'extracted');
  fs.mkdirSync(destination);
  for (const archive of fs.readdirSync(root).filter(name => name.endsWith('.tar.gz'))) {
    const entries = spawnSync('tar', ['tzf', archive], { cwd: root, encoding: 'utf8' });
    expect(entries.status).toBe(0);
    for (const name of ['LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt']) {
      expect(entries.stdout).toContain('/' + name);
    }
    const extracted = spawnSync('tar', ['xzf', archive, '-C', destination], { cwd: root });
    expect(extracted.status).toBe(0);
  }
  const backend = path.join(destination, path.basename(root));
  expect(JSON.parse(fs.readFileSync(path.join(backend, 'package.json'))).overrides).toEqual({ example: '1.0.0' });
  expect(JSON.parse(fs.readFileSync(path.join(backend, 'apps/api/package.json'))).dependencies['@fateclaw/contracts']).toBe('file:../../packages/contracts');
  for (const file of ['packages/contracts/dist/index.js', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt']) {
    expect(fs.existsSync(path.join(backend, file))).toBe(true);
  }
  expect(fs.existsSync(path.join(destination, 'index.html'))).toBe(true);
  expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
});

it.each([1, 2])('limits concurrent targets with --jobs=%s', (jobs) => {
  const result = pack(['--jobs', String(jobs)]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(peakConcurrency()).toBe(jobs);
});

it.each(['api', 'fateclaw-admin'])('stops sibling builds when %s fails and preserves existing archives', (target) => {
  const archive = 'fateclaw-backend-v1.0.0-runtime.tar.gz';
  write(archive, 'previous archive');
  const result = pack([], { PACK_TEST_FAIL: target });
  expect(result.status).toBe(17);
  expect(result.stderr).toContain(`fixture ${target} build failed`);
  expect(fs.readFileSync(path.join(root, archive), 'utf8')).toBe('previous archive');
  expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
  for (const { pid } of events()) {
    expect(() => process.kill(pid, 0)).toThrow();
  }
});

it('reports a contracts failure before starting targets and removes temporary files', () => {
  const result = pack([], { PACK_TEST_FAIL: 'contracts' });
  expect(result.status).toBe(17);
  expect(result.stderr).toContain('fixture contracts build failed');
  expect(events().map(event => event.target)).toEqual(['contracts']);
  expect(fs.readdirSync(path.join(root, 'tmp'))).toEqual([]);
});

it('packages source without a build or staging files when TMPDIR is inside the workspace', () => {
  const result = pack(['backend-source']);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(fs.existsSync(path.join(root, 'events.jsonl'))).toBe(false);
  const archive = 'fateclaw-backend-v1.0.0-source.tar.gz';
  const entries = spawnSync('tar', ['tzf', archive], { cwd: root, encoding: 'utf8' });
  expect(entries.status).toBe(0);
  expect(entries.stdout).toContain('/scripts/pack.sh');
  expect(entries.stdout).not.toContain('/tmp/fateclaw-pack.');
});

it('supports a single-target alias with an absolute output path and rejects invalid concurrency', () => {
  const output = path.join(root, 'custom site.tar.gz');
  expect(pack(['web', output, '--jobs=2']).status).toBe(0);
  expect(fs.existsSync(output)).toBe(true);
  fs.unlinkSync(path.join(root, 'events.jsonl'));
  expect(pack(['--jobs=0']).status).not.toBe(0);
  expect(fs.existsSync(path.join(root, 'events.jsonl'))).toBe(false);
});
