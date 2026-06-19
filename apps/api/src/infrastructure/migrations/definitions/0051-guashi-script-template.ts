import type { DatabaseMigration } from '../types.js';

/**
 * 数据库迁移分段：0051。
 *
 * 话术稿模板：把原本写死在 agent-runtime 系统提示里的「话术稿分节骨架」还给卦师自定义。
 * 在 users 上增加用户级 guashi_script_template 文本字段;为空表示沿用平台默认骨架,
 * 非空则作为本轮解读的章节结构注入系统提示(与 soul_content 平行的纯文本配置)。
 */
export const guashiScriptTemplateMigrations: readonly DatabaseMigration[] = [
  {
    id: '0051_user_guashi_script_template',
    description: '增加用户级话术稿模板配置(为空则用平台默认骨架)',
    async up(client) {
      await client.query(`
        ALTER TABLE users
          ADD COLUMN IF NOT EXISTS guashi_script_template TEXT NOT NULL DEFAULT ''
      `);
    },
  },
];
