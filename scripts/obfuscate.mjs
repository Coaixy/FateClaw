#!/usr/bin/env node
/**
 * 混淆指定目录下的所有 .js 文件：terser 压缩 → javascript-obfuscator 混淆。
 * 同时删除 source map (.js.map) 和声明文件 (.d.ts / .d.ts.map)。
 *
 * 用法: node scripts/obfuscate.mjs <目录> [--light] [--jobs N]
 *   --light  轻量模式：仅 terser 压缩 + 变量混淆，跳过 obfuscator（更快）
 *   --jobs N 并发处理 JS 文件数，默认最多 4 个，避免大项目串行等待
 */

import { readdir, readFile, writeFile, unlink, stat } from 'fs/promises';
import os from 'os';
import path from 'path';
import { minify } from 'terser';
import JavaScriptObfuscator from 'javascript-obfuscator';

const args = process.argv.slice(2);
let lightMode = false;
let targetDir = '';
let jobsArg = '';

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--light') {
    lightMode = true;
  } else if (arg === '--jobs') {
    const value = args[i + 1];
    if (!value || value.startsWith('--')) {
      console.error('用法错误: --jobs 需要一个正整数参数');
      process.exit(1);
    }
    jobsArg = value;
    i++;
  } else if (arg.startsWith('--jobs=')) {
    jobsArg = arg.slice('--jobs='.length);
  } else if (arg.startsWith('--')) {
    console.error(`未知参数: ${arg}`);
    process.exit(1);
  } else if (!targetDir) {
    targetDir = arg;
  } else {
    console.error(`未知位置参数: ${arg}`);
    process.exit(1);
  }
}

if (!targetDir) {
  console.error('用法: node scripts/obfuscate.mjs <目录> [--light] [--jobs N]');
  process.exit(1);
}

const defaultJobs = Math.max(
  1,
  Math.min(4, os.availableParallelism?.() ?? os.cpus().length ?? 1),
);
const jobs = jobsArg ? Number(jobsArg) : defaultJobs;
if (!Number.isInteger(jobs) || jobs < 1) {
  console.error(`--jobs 需要正整数，当前值: ${jobsArg}`);
  process.exit(1);
}

/** 递归收集目录下所有文件 */
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else {
      files.push(full);
    }
  }
  return files;
}

/** terser 压缩配置 */
const terserOptions = {
  module: true, // ES modules（import/export 语法）
  compress: {
    dead_code: true,
    drop_console: false, // 保留 console（Pino logger 依赖它）
    passes: 2,
  },
  mangle: {
    toplevel: false, // 不混淆顶层导出（ES modules 需要）
  },
  format: {
    comments: false,
  },
};

/** javascript-obfuscator 配置（ESM 兼容 + 平衡保护强度与运行性能） */
const obfuscatorOptions = {
  target: 'node',
  compact: true,
  controlFlowFlattening: false, // 关闭：破坏 ESM 动态 import 和 async 控制流
  deadCodeInjection: false,
  identifierNamesGenerator: 'hexadecimal',
  renameGlobals: false,
  selfDefending: false,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.3,
  stringArrayEncoding: [], // 去掉 base64：减少运行时开销，避免字符串解码副作用
  stringArrayThreshold: 0.5,
  splitStrings: false, // 关闭：拆分字符串破坏 Zod schema 字段名和属性反射
  unicodeEscapeSequence: false,
};

async function processFile(filePath) {
  const code = await readFile(filePath, 'utf-8');

  // Step 1: terser 压缩
  const minified = await minify(code, terserOptions);
  if (!minified.code) {
    console.warn(`  ⚠ terser 返回空结果: ${filePath}`);
    return;
  }

  let result = minified.code;

  // Step 2: javascript-obfuscator 混淆（非 light 模式）
  if (!lightMode) {
    const obfuscated = JavaScriptObfuscator.obfuscate(result, obfuscatorOptions);
    result = obfuscated.getObfuscatedCode();
  }

  await writeFile(filePath, result, 'utf-8');
}

async function processWithConcurrency(items, limit, worker) {
  let nextIndex = 0;
  let processed = 0;
  const workerCount = Math.min(limit, items.length);

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex++;

      // 每个 worker 只领取一个文件，避免某个大文件阻塞所有后续小文件。
      await worker(items[index]);

      processed++;
      if (processed % 20 === 0 || processed === items.length) {
        process.stdout.write(`\r  ✅ ${processed}/${items.length}`);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
}

async function main() {
  const resolved = path.resolve(targetDir);
  console.log(
    `🔒 ${lightMode ? '压缩' : '混淆'}目录: ${resolved}`,
  );
  console.log(`  ⚙ 并发数: ${jobs}`);

  const allFiles = await walk(resolved);

  // 删除 source map 和声明文件
  const toDelete = allFiles.filter(
    (f) =>
      f.endsWith('.js.map') ||
      f.endsWith('.d.ts') ||
      f.endsWith('.d.ts.map') ||
      f.endsWith('.tsbuildinfo'),
  );
  await Promise.all(toDelete.map((f) => unlink(f)));
  if (toDelete.length > 0) {
    console.log(`  🗑 删除 ${toDelete.length} 个 map/声明文件`);
  }

  // 混淆 .js 文件
  const jsFiles = allFiles.filter(
    (f) => f.endsWith('.js') && !f.endsWith('.min.js'),
  );
  console.log(`  📝 处理 ${jsFiles.length} 个 JS 文件 ...`);

  await processWithConcurrency(jsFiles, jobs, processFile);
  console.log('');

  // 统计产物大小
  let totalSize = 0;
  for (const f of jsFiles) {
    const s = await stat(f);
    totalSize += s.size;
  }
  const sizeMB = (totalSize / 1024 / 1024).toFixed(1);
  console.log(`  📦 产物总大小: ${sizeMB} MB`);
}

main().catch((err) => {
  console.error('混淆失败:', err);
  process.exit(1);
});
