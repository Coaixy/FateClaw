/**
 * 编排器持久化接口(WorkflowRunStore)的生产实现:包 workflow-run-repository + 定义图装载。
 *
 * loadRun 把 run 行 + 节点行 + 定义图(来自 workflow_definitions,运行不另存快照)组装给编排器。
 */
import { getWorkflowDefinition } from '../../infrastructure/db.js';
import {
  createWorkflowRun,
  getWorkflowRunWithNodes,
  updateWorkflowRunNode,
  updateWorkflowRunStatus,
} from '../../infrastructure/repositories/workflow-run-repository.js';
import type {
  LoadedWorkflowRun,
  WorkflowRunStore,
} from './run-orchestrator.js';

/** 生产环境的运行 store(真库)。 */
export const workflowRunStore: WorkflowRunStore = {
  createRun: createWorkflowRun,
  async loadRun(runId, userId): Promise<LoadedWorkflowRun | null> {
    const found = await getWorkflowRunWithNodes(runId, userId);
    if (!found) {
      return null;
    }
    // 图来自定义;定义被软删/不可读时回退空图(运行节点行仍在,只是无法再推进新节点)。
    const definition = await getWorkflowDefinition(
      found.run.workflow_definition_id,
      userId,
    );
    return {
      run: found.run,
      nodes: found.nodes,
      graph: definition?.graph ?? { nodes: [], edges: [] },
    };
  },
  updateNode: updateWorkflowRunNode,
  updateRunStatus: updateWorkflowRunStatus,
};
