#!/usr/bin/env node

/**
 * 测试用 skill 脚本：
 * - 读取 stdin JSON
 * - 原样回显 message
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
    action: 'ask',
    file: 'ask.js',
    echo: input.message ?? null,
  }),
);
