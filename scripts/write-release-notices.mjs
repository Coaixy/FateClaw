import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), '..');
const noticeName = /(?:^|[._-])(?:licen[cs]es?|copying|notices?|copyright|authors)(?:$|[._-])/i;
const sourceExtension = /\.(?:[cm]?js|[cm]?ts|map|json|node|wasm)$/i;
const bundledNoticesAsset = 'static/THIRD_PARTY_NOTICES.txt';

function packageDirectory(resource) {
  if (!resource || !path.isAbsolute(resource)) return null;
  const filename = resource.split('?')[0];
  if (!filename.split(path.sep).includes('node_modules')) return null;
  let directory = path.dirname(filename);
  while (true) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name && manifest.version) return fs.realpathSync(directory);
    }
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function noticeFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '.git') {
      files.push(...noticeFiles(entryPath));
    } else if (entry.isFile() && noticeName.test(entry.name) && !sourceExtension.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files.sort();
}

export function renderThirdPartyNotices(directories) {
  const packages = new Map();
  for (const directory of directories) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const identity = `${manifest.name}@${manifest.version}`;
    if (!packages.has(identity)) packages.set(identity, { directory, manifest });
  }
  const sections = [
    'FateClaw frontend third-party notices',
    'These packages contribute modules to the emitted browser bundles.',
    'Upstream package notices may also describe embedded components.',
    'Each component remains subject to its own license and copyright notices.',
  ];

  const entries = [...packages.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'));
  for (const [identity, { directory, manifest }] of entries) {
    const files = noticeFiles(directory);
    if (files.length === 0) {
      for (const entry of fs.readdirSync(directory)) {
        if (!/^readme(?:$|\.)/i.test(entry)) continue;
        const filename = path.join(directory, entry);
        const text = fs.readFileSync(filename, 'utf8');
        if (/copyright/i.test(text) && /permission is hereby granted|permission to use, copy, modify/i.test(text)) {
          files.push(filename);
        }
      }
    }
    if (files.length === 0) throw new Error(`No upstream license or notice file found for ${identity}`);
    const license = typeof manifest.license === 'object' ? manifest.license.type : manifest.license;
    const repository = typeof manifest.repository === 'object' ? manifest.repository.url : manifest.repository;
    sections.push(
      '',
      '='.repeat(72),
      identity,
      `Declared license: ${license ?? 'Not declared in package metadata; see the upstream text below.'}`,
      ...(repository ? [`Repository: ${repository}`] : []),
    );
    for (const file of files) {
      sections.push('', `--- ${path.relative(directory, file).split(path.sep).join('/')} ---`, fs.readFileSync(file, 'utf8'));
    }
  }
  return `${sections.join('\n')}\n`;
}

export function createReleaseLicensePlugin() {
  const name = 'FateClawReleaseLicenses';
  return {
    apply(compiler) {
      compiler.hooks.thisCompilation.tap(name, (compilation) => {
        compilation.hooks.processAssets.tap(
          { name, stage: compiler.webpack.Compilation.PROCESS_ASSETS_STAGE_REPORT },
          () => {
            const directories = new Set();
            const collect = (module) => {
              const directory = packageDirectory(module.resource);
              if (directory) directories.add(directory);
              for (const child of module.modules ?? []) collect(child);
            };
            for (const module of compilation.modules) {
              if (compilation.chunkGraph.getNumberOfModuleChunks(module) > 0) collect(module);
            }
            const notices = renderThirdPartyNotices(directories);
            compilation.emitAsset(bundledNoticesAsset, new compiler.webpack.sources.RawSource(notices));
          },
        );
      });
    },
  };
}

export function writeReleaseNotices({ root = projectRoot, scope, outputDirectory }) {
  const apps = { www: 'web', admin: 'admin' };
  let notices;
  if (scope === 'backend') {
    notices = [
      'FateClaw backend dependency notices',
      '',
      'This runtime archive contains compiled FateClaw source, not bundled npm dependencies.',
      'External dependencies are listed in the included package manifests and installed separately.',
      'Retain the upstream license and notice files accompanying those installed packages.',
      '',
    ].join('\n');
  } else if (apps[scope]) {
    const filename = path.join(root, 'apps', apps[scope], 'out/_next', bundledNoticesAsset);
    notices = fs.readFileSync(filename, 'utf8');
  } else {
    throw new Error(`Unknown release notice target: ${scope}`);
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(outputDirectory, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'NOTICE'), path.join(outputDirectory, 'NOTICE'));
  fs.writeFileSync(path.join(outputDirectory, 'THIRD_PARTY_NOTICES.txt'), notices);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const [, , scope, outputDirectory] = process.argv;
  if (!scope || !outputDirectory || process.argv.length !== 4) {
    throw new Error('Usage: node scripts/write-release-notices.mjs <backend|www|admin> <output-directory>');
  }
  writeReleaseNotices({ scope, outputDirectory: path.resolve(outputDirectory) });
  console.log(`[release-notices] ${scope}: preserved project and third-party notices`);
}
