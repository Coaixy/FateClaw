#!/usr/bin/env node

/**
 * 测试用 composite fallback 脚本：
 * - 读取 stdin JSON
 * - 以固定 source 返回回显结果
 */

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf-8').trim();
  return text ? JSON.parse(text) : {};
}

const input = await readStdin();
console.log(
  JSON.stringify({
    ok: true,
    echo: input.message ?? null,
    source: 'fallback-only-composite',
  }),
);
