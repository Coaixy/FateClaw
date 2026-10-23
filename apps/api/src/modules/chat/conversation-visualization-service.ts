import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { Ajv } from 'ajv';
import { compile, type TopLevelSpec } from 'vega-lite';
import { parse, logger, None } from 'vega';
import type {
  VisualizationIpcRequest,
  VisualizationResult,
} from '@fateclaw/contracts/agent/visualization';
import {
  parseVisualizationInput,
  parseVisualizationArtifact,
  visualizationReferences,
  type VisualizationArtifact,
} from '@fateclaw/contracts/visualization';
import type { SkillContextEntryDto } from '@fateclaw/contracts/chat';

import { withActiveConversationRequest } from '#infrastructure/repositories/conversation-tool-repository';
import { storeMessage } from '#infrastructure/repositories/chat-repository';
import { getDbPool, type DbQueryable } from '#infrastructure/db-pool';
import { validateMermaid } from './visualization-parser.js';
import { WEB_CHAT_ASSISTANT_NAME } from './web-chat-runtime.js';

const require = createRequire(import.meta.url);
const validateVega = new Ajv({ strict: false, logger: false }).compile(
  require('vega-lite/vega-lite-schema.json'),
);

export function visualizationEntry(
  artifact: VisualizationArtifact,
): SkillContextEntryDto {
  return {
    skill: 'visualization',
    output: artifact.summary,
    artifactType: 'visualization',
    artifactTitle: artifact.title,
    artifactData: artifact,
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  return value;
}

export async function executeConversationVisualization(
  accountId: string,
  request: VisualizationIpcRequest,
): Promise<VisualizationResult> {
  const parsed = parseVisualizationInput(request.operation);
  if (!parsed.ok)
    return {
      ok: false,
      code: 'VISUALIZATION.INVALID_SPEC',
      error: parsed.error,
    };
  const input = parsed.value;
  if (input.type === 'mermaid') {
    if (!(await validateMermaid(input.spec)))
      return {
        ok: false,
        code: 'VISUALIZATION.INVALID_SPEC',
        error: 'Mermaid 语法无法解析，请简化节点和连线，检查引号及括号后重试',
      };
  } else if (input.type === 'vega-lite') {
    if (!validateVega(input.spec))
      return {
        ok: false,
        code: 'VISUALIZATION.INVALID_SPEC',
        error:
          'Vega-Lite 格式无效，请检查 mark、encoding、data 和 params 的字段类型',
      };
    try {
      const compiled = compile(input.spec as unknown as TopLevelSpec, {
        logger: logger(None),
      }).spec;
      // Parsing validates expressions without executing a dataflow or generating functions.
      parse(compiled, undefined, { ast: true });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'Error') throw error;
      return {
        ok: false,
        code: 'VISUALIZATION.INVALID_SPEC',
        error: '图表描述无法编译或解析，请检查字段、参数和筛选表达式后重试',
      };
    }
  }
  const id = `visualization-${createHash('sha256')
    .update(
      JSON.stringify([
        accountId,
        request.requestId,
        request.operation.toolCallId,
      ]),
    )
    .digest('hex')}`;
  const inputHash = createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
  return withActiveConversationRequest(
    {
      accountId,
      requestId: request.requestId,
      executionId: request.executionId,
    },
    async (owner, db) => {
      const existing = await db.query<{
        tool_context: string;
        timestamp: Date;
        metadata: { visualization_input_hash?: string };
      }>(
        'SELECT tool_context, timestamp, metadata FROM messages WHERE id=$1 AND account_id=$2 AND session_id=$3',
        [id, accountId, owner.sessionId],
      );
      if (existing.rows[0]) {
        const stored = existing.rows[0];
        if (stored.metadata.visualization_input_hash !== inputHash)
          return {
            ok: false,
            code: 'VISUALIZATION.CALL_CONFLICT',
            error: '同一次图形调用的内容发生变化，请使用新的工具调用',
          };
        const [entry] = JSON.parse(
          stored.tool_context,
        ) as SkillContextEntryDto[];
        const artifact = parseVisualizationArtifact(entry?.artifactData);
        if (!artifact) throw new Error('Stored visualization is invalid');
        return {
          ok: true,
          sessionId: owner.sessionId,
          artifact,
          createdAt: new Date(stored.timestamp).toISOString(),
        };
      }
      const artifact: VisualizationArtifact = { ...input, version: 1, id };
      const createdAt = new Date().toISOString();
      await storeMessage(
        {
          id,
          account_id: accountId,
          user_id: owner.userId,
          sender: accountId,
          sender_name: WEB_CHAT_ASSISTANT_NAME,
          content: input.summary,
          timestamp: createdAt,
          is_from_me: true,
          is_bot_message: true,
          session_id: owner.sessionId,
          tool_context: JSON.stringify([visualizationEntry(artifact)]),
          metadata: {
            kind: 'visualization_result',
            request_id: request.requestId,
            tool_call_id: request.operation.toolCallId,
            visualization_input_hash: inputHash,
          },
        },
        db,
      );
      await db.query('UPDATE chat_sessions SET updated_at=now() WHERE id=$1', [
        owner.sessionId,
      ]);
      return { ok: true, sessionId: owner.sessionId, artifact, createdAt };
    },
  );
}

/** Persist referenced artifacts with the answer so pagination never separates a figure from its text. */
export async function resolveMessageVisualizations(
  accountId: string,
  sessionId: string,
  content: string,
  db?: DbQueryable,
): Promise<SkillContextEntryDto[]> {
  const ids = [...new Set(visualizationReferences(content))];
  if (!ids.length) return [];
  const { rows } = await (db ?? getDbPool()).query<{
    id: string;
    tool_context: string;
  }>(
    `SELECT id, tool_context FROM messages WHERE account_id=$1 AND session_id=$2 AND id=ANY($3::text[]) AND deleted_at IS NULL AND metadata->>'kind'='visualization_result'`,
    [accountId, sessionId, ids],
  );
  return ids.flatMap((id) => {
    const row = rows.find((item) => item.id === id);
    if (!row) return [];
    const entries = JSON.parse(row.tool_context) as SkillContextEntryDto[];
    const artifact = parseVisualizationArtifact(entries[0]?.artifactData);
    return artifact && artifact.id === id ? [visualizationEntry(artifact)] : [];
  });
}
