import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const TARGETS = {
  api: path.resolve(ROOT_DIR, 'apps/api/dist'),
  'agent-runner': path.resolve(ROOT_DIR, 'packages/agent-runner/dist'),
};

function resolveTarget(scope) {
  const target = TARGETS[scope];
  if (!target) {
    throw new Error(
      `未知构建产物目录: ${scope}。可选值: ${Object.keys(TARGETS).join(', ')}`,
    );
  }
  return target;
}

const scope = process.argv[2];
if (!scope) {
  throw new Error('缺少构建目标名称，例如: node scripts/clean-build-dist.mjs agent-runner');
}

const targetDir = resolveTarget(scope);

// 构建前清理旧产物，避免已排除的测试文件继续残留在 dist 中。
fs.rmSync(targetDir, { recursive: true, force: true });
console.log(`[clean-build-dist] ${scope}: ${targetDir}`);
