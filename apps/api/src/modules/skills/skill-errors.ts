export class SkillRevisionConflictError extends Error {
  constructor() {
    super(
      '此技能已在其他页面或设备更新。请保留当前草稿，重新加载最新版本后再保存。',
    );
  }
}
