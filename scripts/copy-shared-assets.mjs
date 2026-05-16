import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const SOURCE_FILES = [
  path.resolve(ROOT_DIR, 'apps/api/src/shared/category-aliases.json'),
  path.resolve(ROOT_DIR, 'apps/api/src/shared/model-context-windows.json'),
];
const TARGETS = {
  api: path.resolve(ROOT_DIR, 'apps/api/dist/shared'),
  'agent-runner': path.resolve(ROOT_DIR, 'packages/agent-runner/dist/shared'),
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
