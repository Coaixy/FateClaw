'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { Compass, Plus, Sparkles, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { paipanApi, type PaipanCatalogItem } from '@/features/paipan/api';
import { skillsApi } from '@/features/skills/api';
import {
  workflowsApi,
  type WorkflowDefinition,
  type WorkflowGraphInput,
  type WorkflowNodeInput,
} from '@/features/workflows/api';
import { ApiError } from '@/lib/http/client';
import { useI18n } from '@/lib/i18n';
import { useToast } from '@/lib/use-toast';
import { PaipanParamsForm } from './paipan-params-form';

/** 可选术数(排盘节点)。值为后端 skillDir,标签为卦师可读名。 */
const PAIPAN_OPTIONS: readonly { value: string; label: string }[] = [
  { value: 'bazi-paipan', label: '八字' },
  { value: 'ziwei-paipan', label: '紫微斗数' },
  { value: 'iching-paipan', label: '六爻' },
  { value: 'meihua-paipan', label: '梅花易数' },
  { value: 'liuren-paipan', label: '大六壬' },
  { value: 'qimen-paipan', label: '奇门遁甲' },
  { value: 'jingzhan-paipan', label: '经占' },
];

type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh';

// 用 type 别名(非 interface)定义节点 data,才能满足 React Flow v12 的
// `Node<T extends Record<string, unknown>>` 约束(interface 不满足索引签名约束)。
type PaipanNodeData = {
  kind: 'paipan';
  title: string;
  pauseAfter: boolean;
  skill: string;
  inputDefaults: Record<string, unknown>;
};

type AiNodeData = {
  kind: 'ai';
  title: string;
  pauseAfter: boolean;
  promptTemplate: string;
  skillIds: string[];
  modelPolicy: {
    mode: 'system-default' | 'user-current';
    thinkingLevel: ThinkingLevel;
  };
};

type NodeData = PaipanNodeData | AiNodeData;
type FlowNode = Node<NodeData>;

/** 节点配置补丁:两类节点字段的可选并集,供配置面板局部更新选中节点 data。 */
type NodePatch = Partial<PaipanNodeData> & Partial<AiNodeData>;

interface OwnSkill {
  id: string;
  name: string;
}

/** 生成稳定且仅含 [A-Za-z0-9] 的节点 id(后端约定 nodeId 不能含 '-')。 */
function newNodeId(): string {
  return `n${Math.random().toString(36).slice(2, 9)}`;
}

function newEdgeId(): string {
  return `e${Math.random().toString(36).slice(2, 9)}`;
}

/** 把后端定义的图转成 React Flow 的 nodes/edges(编辑模式用)。 */
function toFlow(workflow: WorkflowDefinition): {
  nodes: FlowNode[];
  edges: Edge[];
} {
  const nodes: FlowNode[] = workflow.graph.nodes.map((node) => {
    if (node.type === 'paipan') {
      return {
        id: node.id,
        type: 'paipan',
        position: node.position ?? { x: 0, y: 0 },
        data: {
          kind: 'paipan',
          title: node.title,
          pauseAfter: node.pauseAfter,
          skill: node.skill,
          inputDefaults: node.inputDefaults ?? {},
        },
      };
    }
    const mode =
      node.modelPolicy?.mode === 'user-current'
        ? 'user-current'
        : 'system-default';
    const thinkingLevel = (node.modelPolicy?.thinkingLevel ??
      'medium') as ThinkingLevel;
    return {
      id: node.id,
      type: 'ai',
      position: node.position ?? { x: 0, y: 0 },
      data: {
        kind: 'ai',
        title: node.title,
        pauseAfter: node.pauseAfter,
        promptTemplate: node.promptTemplate,
        skillIds: node.skillIds ?? [],
        modelPolicy: { mode, thinkingLevel },
      },
    };
  });
  const edges: Edge[] = workflow.graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    markerEnd: { type: MarkerType.ArrowClosed },
  }));
  return { nodes, edges };
}

/** 连 source→target 是否会成环:若现图里 target 已能到达 source,则成环。 */
function wouldCreateCycle(
  edges: Edge[],
  source: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.source) ?? [];
    list.push(edge.target);
    adjacency.set(edge.source, list);
  }
  const stack = [target];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === source) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of adjacency.get(current) ?? []) stack.push(next);
  }
  return false;
}

/** 求某节点的全部上游 AI 节点 id(反向可达,供 AI 节点引用 {{node.<id>.output}})。 */
function upstreamAiNodeIds(
  nodeId: string,
  nodes: FlowNode[],
  edges: Edge[],
): string[] {
  const reverse = new Map<string, string[]>();
  for (const edge of edges) {
    const list = reverse.get(edge.target) ?? [];
    list.push(edge.source);
    reverse.set(edge.target, list);
  }
  const ancestors = new Set<string>();
  const stack = [...(reverse.get(nodeId) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (ancestors.has(current)) continue;
    ancestors.add(current);
    for (const prev of reverse.get(current) ?? []) stack.push(prev);
  }
  return nodes
    .filter((n) => ancestors.has(n.id) && n.data.kind === 'ai')
    .map((n) => n.id);
}

/**
 * 工作流搭建器:在画布上拖拽节点、连线,组成「并行分叉 + 汇总」的断卦流程(DAG)。
 *
 * @param props.mode create=新建,edit=编辑。
 * @param props.workflowId 编辑模式下的工作流 id。
 * @param props.initial 编辑模式下的初始定义。
 */
export function WorkflowBuilder(props: {
  mode: 'create' | 'edit';
  workflowId?: string;
  initial?: WorkflowDefinition;
}) {
  return (
    <ReactFlowProvider>
      <WorkflowBuilderInner {...props} />
    </ReactFlowProvider>
  );
}

function WorkflowBuilderInner({
  mode,
  workflowId,
  initial,
}: {
  mode: 'create' | 'edit';
  workflowId?: string;
  initial?: WorkflowDefinition;
}) {
  const router = useRouter();
  const { t } = useI18n();
  const { toast } = useToast();

  const initialFlow = useMemo(
    () => (initial ? toFlow(initial) : { nodes: [], edges: [] }),
    [initial],
  );

  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(
    initialFlow.nodes,
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    initialFlow.edges,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [ownSkills, setOwnSkills] = useState<OwnSkill[]>([]);
  const [catalog, setCatalog] = useState<PaipanCatalogItem[]>([]);
  const [saving, setSaving] = useState(false);

  // 拉取卦师自己的技能(供 AI 节点绑定)与排盘目录(供排盘节点参数表单)。
  useEffect(() => {
    let cancelled = false;
    skillsApi
      .userList()
      .then((res) => {
        if (cancelled) return;
        setOwnSkills(
          res.own
            .filter((skill) => skill.install_status === 'installed')
            .map((skill) => ({ id: skill.id, name: skill.skill_name })),
        );
      })
      .catch(() => {
        /* 技能拉取失败不阻断搭建,仅 AI 节点无法绑定 */
      });
    paipanApi
      .catalog()
      .then((items) => {
        if (!cancelled) setCatalog(items);
      })
      .catch(() => {
        /* 目录拉取失败不阻断,排盘节点回退为仅选术数 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return;
      if (connection.source === connection.target) return;
      if (wouldCreateCycle(edges, connection.source, connection.target)) {
        toast('error', t('workflows.builder.cycleRejected'));
        return;
      }
      setEdges((eds) =>
        addEdge(
          {
            id: newEdgeId(),
            source: connection.source!,
            target: connection.target!,
            markerEnd: { type: MarkerType.ArrowClosed },
          },
          eds,
        ),
      );
    },
    [edges, setEdges, toast, t],
  );

  const addNode = useCallback(
    (kind: 'paipan' | 'ai') => {
      const id = newNodeId();
      // 简单级联布局,避免新节点叠在一起。
      const count = nodes.length;
      const position = {
        x: 80 + (count % 3) * 240,
        y: 60 + Math.floor(count / 3) * 150,
      };
      const data: NodeData =
        kind === 'paipan'
          ? {
              kind: 'paipan',
              title: '',
              pauseAfter: false,
              skill: '',
              inputDefaults: {},
            }
          : {
              kind: 'ai',
              title: '',
              pauseAfter: true,
              promptTemplate: '',
              skillIds: [],
              modelPolicy: { mode: 'system-default', thinkingLevel: 'medium' },
            };
      setNodes((nds) => [...nds, { id, type: kind, position, data }]);
      setSelectedId(id);
    },
    [nodes.length, setNodes],
  );

  /** 更新选中节点的 data(局部合并,保留判别字段 kind)。 */
  const patchSelected = useCallback(
    (patch: NodePatch) => {
      if (!selectedId) return;
      setNodes((nds) =>
        nds.map((node) =>
          node.id === selectedId
            ? ({ ...node, data: { ...node.data, ...patch } } as FlowNode)
            : node,
        ),
      );
    },
    [selectedId, setNodes],
  );

  const removeSelected = useCallback(() => {
    if (!selectedId) return;
    setNodes((nds) => nds.filter((node) => node.id !== selectedId));
    setEdges((eds) =>
      eds.filter(
        (edge) => edge.source !== selectedId && edge.target !== selectedId,
      ),
    );
    setSelectedId(null);
  }, [selectedId, setNodes, setEdges]);

  const handleSave = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast('error', t('workflows.builder.errNeedName'));
      return;
    }
    if (nodes.length === 0) {
      toast('error', t('workflows.builder.errNeedNode'));
      return;
    }
    for (const node of nodes) {
      if (node.data.kind === 'paipan' && !node.data.skill) {
        toast('error', t('workflows.builder.errPaipanSkill'));
        return;
      }
      if (node.data.kind === 'ai' && !node.data.promptTemplate.trim()) {
        toast('error', t('workflows.builder.errAiPrompt'));
        return;
      }
    }

    // 画布 → 上行图 DTO(AI 节点不带 skillSnapshotIds,由服务端保存时生成)。
    const graphNodes: WorkflowNodeInput[] = nodes.map((node) => {
      const base = {
        id: node.id,
        title:
          node.data.title.trim() ||
          (node.data.kind === 'paipan'
            ? t('workflows.builder.paipanBadge')
            : t('workflows.builder.aiBadge')),
        pauseAfter: node.data.pauseAfter,
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      };
      if (node.data.kind === 'paipan') {
        return {
          ...base,
          type: 'paipan',
          skill: node.data.skill,
          inputDefaults: node.data.inputDefaults,
        };
      }
      return {
        ...base,
        type: 'ai',
        promptTemplate: node.data.promptTemplate.trim(),
        skillIds: node.data.skillIds,
        modelPolicy: node.data.modelPolicy,
      };
    });
    const graph: WorkflowGraphInput = {
      nodes: graphNodes,
      edges: edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
      })),
    };

    setSaving(true);
    try {
      const payload = {
        name: trimmedName,
        description: description.trim(),
        graph,
        enabled,
      };
      if (mode === 'edit' && workflowId) {
        await workflowsApi.update(workflowId, payload);
      } else {
        await workflowsApi.create(payload);
      }
      toast('success', t('workflows.builder.saved'));
      router.push('/workflows');
    } catch (error) {
      toast(
        'error',
        error instanceof ApiError ? error.message : t('workflows.loadError'),
      );
    } finally {
      setSaving(false);
    }
  }, [
    name,
    description,
    enabled,
    nodes,
    edges,
    mode,
    workflowId,
    router,
    t,
    toast,
  ]);

  const nodeTypes = useMemo(
    () => ({ paipan: PaipanNodeView, ai: AiNodeView }),
    [],
  );

  const selected = nodes.find((node) => node.id === selectedId) ?? null;

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold tracking-tight text-ink">
          {mode === 'edit'
            ? t('workflows.builder.editTitle')
            : t('workflows.builder.newTitle')}
        </h1>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => router.push('/workflows')}>
            {t('workflows.builder.cancel')}
          </Button>
          <Button onClick={handleSave} loading={saving}>
            {t('workflows.builder.save')}
          </Button>
        </div>
      </header>

      {/* 基本信息 */}
      <section className="grid gap-3 rounded-2xl border border-hairline bg-surface-card p-4 sm:grid-cols-2">
        <Field label={t('workflows.builder.name')}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('workflows.builder.namePlaceholder')}
            maxLength={60}
            className={inputClass}
          />
        </Field>
        <Field label={t('workflows.builder.description')}>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t('workflows.builder.descriptionPlaceholder')}
            maxLength={500}
            className={inputClass}
          />
        </Field>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4 accent-[var(--primary)]"
          />
          {t('workflows.builder.enabled')}
        </label>
      </section>

      {/* 工具条 */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => addNode('paipan')} className={addBtnClass}>
          <Plus size={13} /> {t('workflows.builder.addPaipan')}
        </button>
        <button type="button" onClick={() => addNode('ai')} className={addBtnClass}>
          <Plus size={13} /> {t('workflows.builder.addAi')}
        </button>
        <span className="ml-auto text-[11px] text-muted/80">
          {t('workflows.builder.canvasHint')}
        </span>
      </div>

      {/* 画布 + 配置面板 */}
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="relative h-[64vh] min-h-[420px] flex-1 overflow-hidden rounded-2xl border border-hairline bg-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_event, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-[12px] text-muted/80">
              {t('workflows.builder.canvasEmpty')}
            </div>
          )}
        </div>

        <aside className="w-full shrink-0 lg:w-[340px]">
          {selected ? (
            <NodeConfigPanel
              key={selected.id}
              node={selected}
              ownSkills={ownSkills}
              catalog={catalog}
              upstreamAi={upstreamAiNodeIds(selected.id, nodes, edges).map(
                (id) => ({
                  id,
                  title: nodes.find((n) => n.id === id)?.data.title?.trim() || id,
                }),
              )}
              onChange={patchSelected}
              onRemove={removeSelected}
            />
          ) : (
            <div className="rounded-2xl border border-dashed border-hairline bg-surface-card p-6 text-center text-[12px] text-muted">
              {t('workflows.builder.configEmpty')}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** 画布上的排盘节点卡片。 */
function PaipanNodeView({ data, selected }: NodeProps) {
  const { t } = useI18n();
  const node = data as PaipanNodeData;
  return (
    <div
      className={`min-w-[150px] rounded-xl border bg-surface-card px-3 py-2 shadow-sm transition-colors ${
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-hairline'
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        <Compass size={13} className="text-primary" />
        <span className="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
          {t('workflows.builder.paipanBadge')}
        </span>
        {node.pauseAfter && <PauseDot />}
      </div>
      <p className="mt-1 truncate text-[12px] font-medium text-ink">
        {node.title || t('workflows.builder.paipanBadge')}
      </p>
      <p className="truncate text-[11px] text-muted">
        {PAIPAN_OPTIONS.find((o) => o.value === node.skill)?.label ||
          t('workflows.builder.skill')}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

/** 画布上的 AI 节点卡片。 */
function AiNodeView({ data, selected }: NodeProps) {
  const { t } = useI18n();
  const node = data as AiNodeData;
  return (
    <div
      className={`min-w-[150px] rounded-xl border bg-surface-card px-3 py-2 shadow-sm transition-colors ${
        selected ? 'border-primary ring-2 ring-primary/30' : 'border-hairline'
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5">
        <Sparkles size={13} className="text-success" />
        <span className="rounded-md bg-success/10 px-1.5 py-0.5 text-[10px] font-medium text-success">
          {t('workflows.builder.aiBadge')}
        </span>
        {node.pauseAfter && <PauseDot />}
      </div>
      <p className="mt-1 truncate text-[12px] font-medium text-ink">
        {node.title || t('workflows.builder.aiBadge')}
      </p>
      <p className="truncate text-[11px] text-muted">
        {node.skillIds.length > 0
          ? `${t('workflows.builder.bindSkills')} × ${node.skillIds.length}`
          : t('workflows.builder.prompt')}
      </p>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function PauseDot() {
  const { t } = useI18n();
  return (
    <span
      title={t('workflows.builder.pauseAfter')}
      className="ml-auto h-2 w-2 rounded-full bg-amber-400"
    />
  );
}

function NodeConfigPanel({
  node,
  ownSkills,
  catalog,
  upstreamAi,
  onChange,
  onRemove,
}: {
  node: FlowNode;
  ownSkills: OwnSkill[];
  catalog: PaipanCatalogItem[];
  upstreamAi: { id: string; title: string }[];
  onChange: (patch: NodePatch) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const data = node.data;

  return (
    <div className="space-y-4 rounded-2xl border border-hairline bg-surface-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">
          {t('workflows.builder.configTitle')}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('workflows.builder.removeNode')}
          className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-error/10 hover:text-error"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <Field label={t('workflows.builder.nodeName')}>
        <input
          value={data.title}
          onChange={(event) => onChange({ title: event.target.value })}
          placeholder={t('workflows.builder.nodeNamePlaceholder')}
          maxLength={60}
          className={inputClass}
        />
      </Field>

      {data.kind === 'paipan' ? (
        <PaipanConfig data={data} catalog={catalog} onChange={onChange} />
      ) : (
        <AiConfig
          data={data}
          ownSkills={ownSkills}
          upstreamAi={upstreamAi}
          onChange={onChange}
        />
      )}

      <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
        <input
          type="checkbox"
          checked={data.pauseAfter}
          onChange={(event) => onChange({ pauseAfter: event.target.checked })}
          className="h-3.5 w-3.5 accent-[var(--primary)]"
        />
        {t('workflows.builder.pauseAfter')}
      </label>
    </div>
  );
}

function PaipanConfig({
  data,
  catalog,
  onChange,
}: {
  data: PaipanNodeData;
  catalog: PaipanCatalogItem[];
  onChange: (patch: NodePatch) => void;
}) {
  const { t } = useI18n();
  const schema = catalog.find((item) => item.skill === data.skill)?.parameters;

  return (
    <div className="space-y-3">
      <Field label={t('workflows.builder.skill')}>
        <select
          value={data.skill}
          onChange={(event) =>
            // 切术数时清空旧参数(不同术数参数集不同)。
            onChange({ skill: event.target.value, inputDefaults: {} })
          }
          className={inputClass}
        >
          <option value="">—</option>
          {PAIPAN_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {data.skill && (
        <Field label={t('workflows.builder.paipanParams')}>
          <PaipanParamsForm
            schema={schema}
            value={data.inputDefaults}
            onChange={(next) => onChange({ inputDefaults: next })}
            emptyHint={t('workflows.builder.paipanParamsNone')}
          />
          <p className="mt-1.5 text-[11px] text-muted/80">
            {t('workflows.builder.paipanParamsHint')}
          </p>
        </Field>
      )}
    </div>
  );
}

function AiConfig({
  data,
  ownSkills,
  upstreamAi,
  onChange,
}: {
  data: AiNodeData;
  ownSkills: OwnSkill[];
  upstreamAi: { id: string; title: string }[];
  onChange: (patch: NodePatch) => void;
}) {
  const { t } = useI18n();

  const insertRef = (token: string) => {
    const base = data.promptTemplate;
    const next =
      base && !base.endsWith('\n') ? `${base} ${token}` : `${base}${token}`;
    onChange({ promptTemplate: next });
  };

  const toggleSkill = (skillId: string) => {
    const has = data.skillIds.includes(skillId);
    onChange({
      skillIds: has
        ? data.skillIds.filter((id) => id !== skillId)
        : [...data.skillIds, skillId],
    });
  };

  return (
    <div className="space-y-3">
      <Field label={t('workflows.builder.prompt')}>
        <textarea
          value={data.promptTemplate}
          onChange={(event) => onChange({ promptTemplate: event.target.value })}
          placeholder={t('workflows.builder.promptPlaceholder')}
          rows={5}
          className={`${inputClass} resize-y`}
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-muted">
            {t('workflows.builder.refHint')}
          </span>
          <button
            type="button"
            onClick={() => insertRef('{{input.question}}')}
            className={chipClass}
          >
            {t('workflows.builder.refQuestion')}
          </button>
          {upstreamAi.length === 0 ? (
            <span className="text-[11px] text-muted/70">
              {t('workflows.builder.upstreamRefEmpty')}
            </span>
          ) : (
            upstreamAi.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => insertRef(`{{node.${item.id}.output}}`)}
                className={chipClass}
              >
                {t('workflows.builder.refNode', { title: item.title })}
              </button>
            ))
          )}
        </div>
      </Field>

      <Field label={t('workflows.builder.bindSkills')}>
        {ownSkills.length === 0 ? (
          <p className="text-[12px] text-muted">
            {t('workflows.builder.noOwnSkills')}
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {ownSkills.map((skill) => {
              const active = data.skillIds.includes(skill.id);
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => toggleSkill(skill.id)}
                  className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[12px] transition-colors ${
                    active
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-hairline bg-canvas text-muted hover:border-primary/30'
                  }`}
                >
                  <Sparkles size={11} />
                  {skill.name}
                </button>
              );
            })}
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-muted/80">
          {t('workflows.builder.bindSkillsHint')}
        </p>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label={t('workflows.builder.model')}>
          <select
            value={data.modelPolicy.mode}
            onChange={(event) =>
              onChange({
                modelPolicy: {
                  ...data.modelPolicy,
                  mode: event.target
                    .value as AiNodeData['modelPolicy']['mode'],
                },
              })
            }
            className={inputClass}
          >
            <option value="system-default">
              {t('workflows.builder.modelDefault')}
            </option>
            <option value="user-current">
              {t('workflows.builder.modelCurrent')}
            </option>
          </select>
        </Field>
        <Field label={t('workflows.builder.thinking')}>
          <select
            value={data.modelPolicy.thinkingLevel}
            onChange={(event) =>
              onChange({
                modelPolicy: {
                  ...data.modelPolicy,
                  thinkingLevel: event.target.value as ThinkingLevel,
                },
              })
            }
            className={inputClass}
          >
            <option value="off">{t('workflows.builder.thinkOff')}</option>
            <option value="low">{t('workflows.builder.thinkLow')}</option>
            <option value="medium">{t('workflows.builder.thinkMid')}</option>
            <option value="high">{t('workflows.builder.thinkHigh')}</option>
            <option value="xhigh">{t('workflows.builder.thinkXHigh')}</option>
          </select>
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

const inputClass =
  'w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-[13px] text-ink placeholder:text-muted focus:border-primary focus:outline-none';

const addBtnClass =
  'inline-flex items-center gap-1 rounded-lg border border-hairline bg-canvas px-2.5 py-1.5 text-[12px] font-medium text-muted hover:border-primary/30 hover:text-ink';

const chipClass =
  'inline-flex items-center rounded-full border border-primary/30 bg-primary/8 px-2 py-0.5 text-[11px] text-primary hover:bg-primary/15';
