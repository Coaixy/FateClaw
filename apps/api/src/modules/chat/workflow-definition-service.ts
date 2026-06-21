/**
 * 卦师自定义工作流"定义"服务层。
 *
 * 负责工作流定义的 CRUD、归属校验与 record→DTO 映射,让 HTTP route 只处理协议与状态码。
 *
 * @remarks AI 步绑定 skill 的"快照"在保存时由仓储层于事务内生成(冻结副本,运行时用副本而非
 *          活 skill),见 workflow-definition-repository。绑定 skill 不存在/不可用时仓储抛
 *          WorkflowSkillUnavailableError,这里映射为 400。
 */
import type {
  WorkflowDefinitionDto,
  WorkflowGraphDto,
} from '@fateclaw/contracts/workflow';
import type { SuccessResponse } from '@fateclaw/contracts/common';

import {
  createWorkflowDefinition,
  getWorkflowDefinition,
  listWorkflowDefinitionsByUserId,
  softDeleteWorkflowDefinition,
  updateWorkflowDefinition,
  WorkflowSkillUnavailableError,
  type WorkflowDefinitionRecord,
} from '../../infrastructure/db.js';
import { fail, ok, type ServiceResult } from '../../shared/service-result.js';

/** 工作流创建/更新的归一化入参(graph 已是完整图,AI 节点 skillSnapshotIds 由仓储兜底)。 */
export interface WorkflowDefinitionWriteInput {
  name: string;
  description: string;
  graph: WorkflowGraphDto;
  enabled: boolean;
  sortOrder: number;
}

/** 绑定 skill 不可用时的对外文案。 */
const SKILL_UNAVAILABLE_MESSAGE = '工作流绑定的技能不存在或不可用,请检查后重试';

/** 工作流定义记录映射为对外稳定协议 DTO(去掉内部 user_id)。 */
function toWorkflowDefinitionDto(
  record: WorkflowDefinitionRecord,
): WorkflowDefinitionDto {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    graph: record.graph,
    enabled: record.enabled,
    sort_order: record.sort_order,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

/**
 * 列出当前卦师名下的全部工作流。
 *
 * @param userId 工作流归属用户 ID。
 */
export async function listWorkflowDefinitionsForOwnedUser(
  userId: string,
): Promise<ServiceResult<WorkflowDefinitionDto[]>> {
  const records = await listWorkflowDefinitionsByUserId(userId);
  return ok(records.map(toWorkflowDefinitionDto));
}

/**
 * 读取当前卦师名下的单个工作流。
 *
 * @param userId 工作流归属用户 ID。
 * @param id 工作流定义 ID。
 * @returns 工作流 DTO;不存在或无权限时返回 404。
 */
export async function getWorkflowDefinitionForOwnedUser(
  userId: string,
  id: string,
): Promise<ServiceResult<WorkflowDefinitionDto>> {
  const record = await getWorkflowDefinition(id, userId);
  if (!record) {
    return fail(404, '工作流不存在');
  }
  return ok(toWorkflowDefinitionDto(record));
}

/**
 * 创建工作流(保存时为 AI 步生成 skill 快照)。
 *
 * @param userId 工作流归属用户 ID。
 * @param input 归一化后的写入入参。
 * @returns 新建工作流 DTO;绑定技能不可用时 400。
 */
export async function createWorkflowDefinitionForOwnedUser(
  userId: string,
  input: WorkflowDefinitionWriteInput,
): Promise<ServiceResult<WorkflowDefinitionDto>> {
  try {
    const record = await createWorkflowDefinition({
      userId,
      name: input.name,
      description: input.description,
      graph: input.graph,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
    });
    return ok(toWorkflowDefinitionDto(record));
  } catch (error) {
    if (error instanceof WorkflowSkillUnavailableError) {
      return fail(400, SKILL_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

/**
 * 更新工作流(整体覆盖语义;保存时刷新 AI 步 skill 快照)。
 *
 * @param userId 工作流归属用户 ID。
 * @param id 工作流定义 ID。
 * @param input 归一化后的写入入参。
 * @returns 更新后的工作流 DTO;不存在或无权限时 404,绑定技能不可用时 400。
 */
export async function updateWorkflowDefinitionForOwnedUser(
  userId: string,
  id: string,
  input: WorkflowDefinitionWriteInput,
): Promise<ServiceResult<WorkflowDefinitionDto>> {
  try {
    const record = await updateWorkflowDefinition(id, userId, {
      name: input.name,
      description: input.description,
      graph: input.graph,
      enabled: input.enabled,
      sortOrder: input.sortOrder,
    });
    if (!record) {
      return fail(404, '工作流不存在');
    }
    return ok(toWorkflowDefinitionDto(record));
  } catch (error) {
    if (error instanceof WorkflowSkillUnavailableError) {
      return fail(400, SKILL_UNAVAILABLE_MESSAGE);
    }
    throw error;
  }
}

/**
 * 软删除工作流。
 *
 * @param userId 工作流归属用户 ID。
 * @param id 工作流定义 ID。
 * @returns 成功响应;不存在或无权限时返回 404。
 */
export async function deleteWorkflowDefinitionForOwnedUser(
  userId: string,
  id: string,
): Promise<ServiceResult<SuccessResponse>> {
  const deleted = await softDeleteWorkflowDefinition(id, userId);
  if (!deleted) {
    return fail(404, '工作流不存在');
  }
  return ok({ success: true });
}
