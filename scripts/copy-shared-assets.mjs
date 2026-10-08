import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const SOURCE_FILES = [
  path.resolve(
    ROOT_DIR,
    'packages/backend-shared/assets/category-aliases.json',
  ),
  path.resolve(
    ROOT_DIR,
    'packages/backend-shared/assets/model-context-windows.json',
  ),
];
const TARGETS = {
  api: path.resolve(ROOT_DIR, 'apps/api/dist/shared'),
  'agent-runtime': path.resolve(ROOT_DIR, 'apps/agent-runtime/dist/shared'),
};

function resolveTargets(scope) {
  if (scope === 'all') {
    return Object.entries(TARGETS);
  }

  const target = TARGETS[scope];
  if (!target) {
    throw new Error(
      `未知构建资源复制目标: ${scope}。可选值: ${Object.keys(TARGETS).join(', ')}, all`,
    );
  }

  return [[scope, target]];
}

const scope = process.argv[2] ?? 'all';
const targets = resolveTargets(scope);

for (const [name, targetDir] of targets) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const sourceFile of SOURCE_FILES) {
    const targetFile = path.resolve(targetDir, path.basename(sourceFile));
    fs.copyFileSync(sourceFile, targetFile);
    console.log(`[copy-shared-assets] ${name}: ${targetFile}`);
  }
}

if (targets.some(([name]) => name === 'api')) {
  const sourceDir = path.resolve(
    ROOT_DIR,
    'apps/api/src/infrastructure/migrations/baselines',
  );
  const targetDir = path.resolve(
    ROOT_DIR,
    'apps/api/dist/infrastructure/migrations/baselines',
  );
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of fs.readdirSync(sourceDir)) {
    if (!file.endsWith('.sql')) continue;
    fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
  }
}
