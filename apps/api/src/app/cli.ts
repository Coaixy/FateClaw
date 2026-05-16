/**
 * FateClaw CLI - 交互式命令入口
 *
 * 用法:
 *   npx tsx apps/api/src/app/cli.ts login    扫码登录微信账号
 *   npx tsx apps/api/src/app/cli.ts list     列出已绑定的账号
 *   npx tsx apps/api/src/app/cli.ts remove   移除账号
 */

import { initDatabase } from '../infrastructure/db.js';
import { addAccount, listAccounts, removeAccount } from './index.js';
import { scanLogin } from '../infrastructure/ilink.js';

async function cmdLogin(): Promise<void> {
  await initDatabase();

  console.log('正在连接微信 ClawBot...');
  const result = await scanLogin();

  // 从 user_id 提取一个可读的名字（取 @ 前的部分作为昵称）
  const name = result.user_id.split('@')[0] ?? '微信用户';

  const account = await addAccount(
    name,
    result.user_id,
    result.bot_token,
    result.account_id,
    result.base_url,
  );

  console.log(`\n✅ 账号绑定成功！`);
  console.log(`   账号名：${account.name}`);
  console.log(`   账号ID：${account.id}`);
  console.log(`\n运行 npm start 启动 FateClaw AI 伴侣`);
}

async function cmdList(): Promise<void> {
  await initDatabase();
  const accounts = await listAccounts();

  if (accounts.length === 0) {
    console.log(
      '暂无绑定账号。运行 "npx tsx apps/api/src/app/cli.ts login" 添加。',
    );
    return;
  }

  console.log(`\n已绑定账号 (${accounts.length}):\n`);
  for (const a of accounts) {
    console.log(`  [${a.enabled ? '✓' : '✗'}] ${a.name}  |  ${a.id}`);
  }
  console.log();
}

async function cmdRemove(): Promise<void> {
  await initDatabase();
  const accounts = await listAccounts();

  if (accounts.length === 0) {
    console.log('没有可移除的账号。');
    return;
  }

  console.log('请选择要移除的账号 ID：');
  accounts.forEach((a, i) => {
    console.log(`  ${i + 1}. ${a.name} (${a.id})`);
  });

  // 简单交互：从命令行参数读取
  const args = process.argv.slice(3);
  const idx = parseInt(args[0] ?? '', 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= accounts.length) {
    console.log('无效的选择。');
    return;
  }

  await removeAccount(accounts[idx].id);
  console.log(`已移除账号 ${accounts[idx].name}`);
}

// ─── 路由 ────────────────────────────────────────────────────────────────

const cmd = process.argv[2] ?? 'help';

switch (cmd) {
  case 'login':
    await cmdLogin();
    break;
  case 'list':
    await cmdList();
    break;
  case 'remove':
    await cmdRemove();
    break;
  default:
    console.log(`用法: npx tsx apps/api/src/app/cli.ts <command>

命令:
  login   扫码登录微信账号（ClawBot）
  list    列出已绑定的账号
  remove  移除账号
`);
}
