import { createHash } from 'node:crypto';
import type {
  PaipanIpcRequest,
  PaipanResult,
} from '@fateclaw/contracts/agent/paipan';
import type { SkillContextEntryDto } from '@fateclaw/contracts/chat';
import type { SessionBoardContext } from '@fateclaw/contracts/agent';

import { withActiveConversationRequest } from '#infrastructure/repositories/conversation-tool-repository';
import { storeMessage } from '#infrastructure/repositories/chat-repository';
import { applyClientProfilePrefill } from './client-profile-service.js';
import {
  executeDirectPaipan,
  listDirectPaipanCatalog,
} from './paipan-runtime.js';
import { WEB_CHAT_ASSISTANT_NAME } from './web-chat-runtime.js';

function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonicalInput(item)]),
    );
  }
  return value;
}

function asBoard(
  id: string,
  timestamp: string,
  entry: SkillContextEntryDto,
): SessionBoardContext {
  return {
    sourceMessageId: id,
    source: 'official_paipan',
    skill: entry.skill,
    artifactTitle: entry.artifactTitle,
    promptText: entry.output,
    artifactData: entry.artifactData,
    createdAt: timestamp,
    isCurrent: true,
  };
}

export async function executeConversationPaipan(
  accountId: string,
  request: PaipanIpcRequest,
): Promise<PaipanResult> {
  return withActiveConversationRequest(
    {
      accountId,
      requestId: request.requestId,
      executionId: request.executionId,
    },
    async (owner, db) => {
      const operation = request.operation;
      if (operation.mode === 'catalog') {
        const catalog = await listDirectPaipanCatalog(owner.userId, db);
        return {
          ok: true,
          mode: 'catalog',
          catalog: operation.skill
            ? catalog.filter((item) => item.skill === operation.skill)
            : catalog,
        };
      }

      const messageId = `paipan-tool-${createHash('sha256')
        .update(
          JSON.stringify([accountId, request.requestId, operation.toolCallId]),
        )
        .digest('hex')}`;
      const inputHash = createHash('sha256')
        .update(
          JSON.stringify([operation.skill, canonicalInput(operation.input)]),
        )
        .digest('hex');
      const existing = await db.query<{
        tool_context: string;
        timestamp: Date;
        metadata: { paipan_input_hash?: string };
      }>(
        'SELECT tool_context, timestamp, metadata FROM messages WHERE id=$1 AND account_id=$2 AND session_id=$3',
        [messageId, accountId, owner.sessionId],
      );
      if (existing.rows[0]) {
        const stored = existing.rows[0];
        if (stored.metadata.paipan_input_hash !== inputHash) {
          return {
            ok: false,
            code: 'PAIPAN.CALL_CONFLICT',
            error: '同一次起盘调用的参数发生变化，请重新发起请求',
          };
        }
        const [entry] = JSON.parse(
          stored.tool_context,
        ) as SkillContextEntryDto[];
        return {
          ok: true,
          mode: 'create',
          sessionId: owner.sessionId,
          board: asBoard(
            messageId,
            new Date(stored.timestamp).toISOString(),
            entry,
          ),
        };
      }

      const input = owner.clientId
        ? await applyClientProfilePrefill(
            owner.userId,
            owner.clientId,
            operation.input,
            db,
          )
        : operation.input;
      const { skillContextEntry } = await executeDirectPaipan({
        accountId,
        userId: owner.userId,
        skillDir: operation.skill,
        input,
        db,
      });
      const timestamp = new Date().toISOString();
      await storeMessage(
        {
          id: messageId,
          account_id: accountId,
          user_id: owner.userId,
          sender: accountId,
          sender_name: WEB_CHAT_ASSISTANT_NAME,
          content: `已生成${skillContextEntry.artifactTitle || operation.skill}。`,
          timestamp,
          is_from_me: true,
          is_bot_message: true,
          session_id: owner.sessionId,
          tool_context: JSON.stringify([skillContextEntry]),
          metadata: {
            kind: 'board_result',
            workflow: 'conversation_paipan',
            board_skill: operation.skill,
            request_id: request.requestId,
            tool_call_id: operation.toolCallId,
            paipan_input_hash: inputHash,
          },
        },
        db,
      );
      await db.query('UPDATE chat_sessions SET updated_at=now() WHERE id=$1', [
        owner.sessionId,
      ]);
      return {
        ok: true,
        mode: 'create',
        sessionId: owner.sessionId,
        board: asBoard(messageId, timestamp, skillContextEntry),
      };
    },
  );
}
