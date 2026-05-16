/**
 * manage_skill 工具 — 开启或关闭一个 Skill。
 *
 * 直接更新数据库中的技能启用状态。
 */

import type { ToolSpec } from '../../types.js';
import { getDefaultAgentRuntimeDeps } from '../../deps.js';
import {
  loadSkillMetadataList,
  loadEnabledSkillNames,
} from '../../prompt/skills.js';
import { getContext } from '../../context.js';
import { log } from '../../io.js';
import { throwIfAborted } from '../../timeout.js';

export const manageSkill: ToolSpec = {
  executionMode: 'exclusive',
  definition: {
    type: 'function',
    function: {
      name: 'manage_skill',
      description:
        '开启或关闭一个 Skill。开启后 AI 可在对话中使用该 Skill，关闭后不再加载。',
      parameters: {
        type: 'object',
        properties: {
          skill_name: {
            type: 'string',
            description: 'skill 目录名（与 load_skill 使用的 skill_name 一致）',
          },
          action: {
            type: 'string',
            enum: ['enable', 'disable'],
            description: '开启或关闭',
          },
        },
        required: ['skill_name', 'action'],
      },
    },
  },

  prompt: `## manage_skill — 管理技能开关

开启或关闭指定的 Skill。Skill 的启用状态会影响后续对话中 AI 是否能使用该 Skill。

### 操作说明
- **enable**：开启一个 Skill。开启后，AI 在后续对话中可以加载并执行该 Skill 的脚本。system prompt 中也会包含该 Skill 的摘要信息。
- **disable**：关闭一个 Skill。关闭后，AI 将无法加载或执行该 Skill。system prompt 中不再显示该 Skill 的信息。

### 使用场景
- 用户明确要求"关闭/禁用某个功能"时。
- 用户要求"开启/启用某个功能"时。
- 用户觉得某个 Skill 不需要或干扰对话时。

### 注意事项
- skill_name 使用目录名（如 "qimen"），不是显示名称（如 "奇门遁甲"）。
- 如果 Skill 已经处于目标状态（如已开启的再次开启），会返回"已经是 XX 状态"的提示。
- 操作通过 IPC 发送给宿主机异步执行，启用状态的变更会在下次对话时生效。
- skill_name 不能包含路径分隔符。`,

  execute: async (args: Record<string, unknown>, options) => {
    const skillName = args.skill_name as string;
    const action = args.action as 'enable' | 'disable';
    const ctx = getContext();
    const deps = options?.runtimeDeps ?? getDefaultAgentRuntimeDeps();
    const allSkills = await loadSkillMetadataList(
      undefined,
      ctx.accountId,
      deps,
    );

    if (skillName.includes('/') || skillName.includes('\\')) {
      return { output: 'skill 名称不能包含路径分隔符。', isError: true };
    }

    const matched = allSkills.find((s) => s.dir === skillName);
    if (!matched) {
      const available = allSkills.map((s) => s.dir).join(', ') || '无';
      return {
        output: `未找到 skill "${skillName}"。可用: ${available}`,
        isError: true,
      };
    }

    if (matched.type === 'user') {
      return {
        output: `用户知识技能 "${matched.name}" 不支持通过 manage_skill 开关，请在技能面板中管理其启用状态。`,
        isError: true,
      };
    }

    const enabledList = await loadEnabledSkillNames(deps);
    if (action === 'enable' && enabledList.includes(matched.name)) {
      return { output: `Skill "${matched.name}" 已经是开启状态。` };
    }
    if (action === 'disable' && !enabledList.includes(matched.name)) {
      return { output: `Skill "${matched.name}" 已经是关闭状态。` };
    }

    // 直接更新数据库
    throwIfAborted(options?.signal, 'manage_skill 已取消');
    await deps.skillCatalog.toggleUserSkill(ctx.userId, matched.name, action);

    const verb = action === 'enable' ? '开启' : '关闭';
    log(
      `工具结果: manage_skill accountId=${ctx.accountId} skill=${skillName} action=${action}`,
    );
    return { output: `Skill "${skillName}" 已${verb}。` };
  },
};
