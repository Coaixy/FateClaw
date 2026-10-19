import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createReleaseLicensePlugin,
  renderThirdPartyNotices,
  writeReleaseNotices,
} from '../scripts/write-release-notices.mjs';

let root;

function packageAt(directory, manifest, files = {}) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(directory, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return directory;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'fateclaw-license-test-'));
  packageAt(root, { name: 'fateclaw', version: '1.0.0' }, {
    LICENSE: 'Project GPL license text',
    NOTICE: 'Copyright (C) Project author',
  });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('release notices', () => {
  it('preserves distinct package versions, embedded notices, and license grants published in a README', () => {
    const first = packageAt(path.join(root, 'first'), { name: 'shared', version: '1.0.0', license: 'MIT' }, {
      LICENSE: 'First upstream copyright and permission',
      'vendor/THIRD-PARTY-NOTICES.txt': 'Embedded component attribution',
    });
    const second = packageAt(path.join(root, 'second'), { name: 'shared', version: '2.0.0', license: 'MIT' }, {
      'README.md': 'Copyright (C) Second author\nPermission is hereby granted to use this fixture.',
    });

    const notices = renderThirdPartyNotices([second, first, first]);
    expect(notices.match(/^shared@1\.0\.0$/gm)).toHaveLength(1);
    expect(notices).toContain('First upstream copyright and permission');
    expect(notices).toContain('Embedded component attribution');
    expect(notices).toContain('Copyright (C) Second author');
  });

  it('ships licenses for emitted Webpack modules, including concatenated modules, with the project license', async () => {
    const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
    const webpackModule = require('next/dist/compiled/webpack/webpack');
    const { webpack } = webpackModule;
    packageAt(path.join(root, 'node_modules/bundled'), {
      name: 'bundled', version: '1.0.0', main: 'index.js', type: 'module', dependencies: { used: '1', unused: '1' },
    }, {
      LICENSE: 'Bundled copyright and permission',
      'index.js': 'import { value } from "used"; export function getValue() { return { label: "bundled", value }; }',
    });
    packageAt(path.join(root, 'node_modules/used'), {
      name: 'used', version: '1.0.0', main: 'index.js', type: 'module',
    }, { LICENSE: 'Used transitive copyright and permission', 'index.js': 'export const value = 42;' });
    packageAt(path.join(root, 'node_modules/unused'), { name: 'unused', version: '1.0.0' });
    fs.writeFileSync(path.join(root, 'entry.js'), 'import { getValue } from "bundled"; console.log(getValue());');
    const outputDirectory = path.join(root, 'apps/web/out');
    const compiler = webpack({
      mode: 'production',
      context: root,
      entry: './entry.js',
      output: { path: path.join(outputDirectory, '_next'), filename: 'app.js' },
      optimization: { minimize: false },
      plugins: [createReleaseLicensePlugin()],
    });
    await new Promise((resolve, reject) => {
      compiler.run((error, stats) => {
        compiler.close((closeError) => {
          if (error || closeError) return reject(error ?? closeError);
          if (stats.hasErrors()) return reject(new Error(stats.toString({ all: false, errors: true })));
          resolve();
        });
      });
    });

    writeReleaseNotices({ root, scope: 'www', outputDirectory });
    expect(fs.readFileSync(path.join(outputDirectory, 'LICENSE'), 'utf8')).toBe('Project GPL license text');
    expect(fs.readFileSync(path.join(outputDirectory, 'NOTICE'), 'utf8')).toBe('Copyright (C) Project author');
    const notices = fs.readFileSync(path.join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    expect(notices).toContain('Bundled copyright and permission');
    expect(notices).toContain('Used transitive copyright and permission');
    expect(notices).not.toContain('unused@');
  });

  it('fails before writing release materials when a bundled package or static build lacks license evidence', () => {
    const component = packageAt(path.join(root, 'component'), { name: 'component', version: '1.0.0', license: 'MIT' });
    expect(() => renderThirdPartyNotices([component])).toThrow('No upstream license or notice file');
    const outputDirectory = path.join(root, 'release');
    expect(() => writeReleaseNotices({ root, scope: 'admin', outputDirectory })).toThrow();
    expect(fs.existsSync(outputDirectory)).toBe(false);
  });
});
