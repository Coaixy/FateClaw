import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0057。
 *
 * 微信 Claw 功能可逆停用（产品决策：暂不对外提供，未来或重启）。把所有微信账号置
 * enabled=false，作为应用层 entitlements.canUseWechatClaw=false 总开关之外的数据层双保险：
 * getEnabledAccounts 返回空，启动时不再为任何账号拉起 iLink 长轮询。
 *
 * 可逆：不删除 accounts 行与 bot_token 凭证，也不动 wechat_chat_session_links；未来恢复时
 * 重新启用账号 + 改回 entitlements 开关即可。幂等：仅命中 enabled=true 行，重复执行为空操作。
 */
export const disableWechatAccountsMigrations: readonly DatabaseMigration[] = [
  {
    id: '0057_disable_wechat_claw_accounts',
    description: '微信 Claw 可逆停用：所有账号 enabled=false（保留行与凭证）',
    async up(client) {
      await client.query(`
        UPDATE accounts SET enabled = false WHERE enabled = true
      `);
    },
  },
];
