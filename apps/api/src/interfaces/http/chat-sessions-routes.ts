import { FastifyInstance } from 'fastify';
import type {
  ChatSessionSendRequestDto,
  QueryProcessStepDto,
} from '@fateclaw/contracts/chat';

import {
  createChatSessionForOwnedUser,
  deleteOwnedChatSession,
  getOwnedChatSessionMessages,
  getOwnedChatSessionQueryProcessSource,
  listChatSessionsForOwnedUser,
  renameOwnedChatSession,
  sendOwnedChatSessionMessage,
} from '../../modules/chat/chat-session-service.js';
import { toQueryProcessResponseDto } from '../../contracts-adapter/chat-contract.js';
import { normalizeChatSessionMessageBody } from '../../modules/chat/pasted-board-input.js';

interface TraceLikeEntry {
  type?: unknown;
  timestamp?: unknown;
  tool?: unknown;
  toolName?: unknown;
  args?: unknown;
  queryText?: unknown;
  skillDir?: unknown;
  skillName?: unknown;
  sectionTitle?: unknown;
  forceSkillDirs?: unknown;
  forceSkillNames?: unknown;
  queryableSkillDirs?: unknown;
  queryableSkillNames?: unknown;
  iterations?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function toTraceEntries(value: unknown): TraceLikeEntry[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is TraceLikeEntry =>
          !!item && typeof item === 'object' && !Array.isArray(item),
      )
    : [];
}

function formatSkillList(names: string[], dirs: string[]): string | undefined {
  const labels = new Set<string>();
  for (const name of names) labels.add(name);
  for (const dir of dirs) labels.add(dir);
  if (labels.size === 0) return undefined;
  return Array.from(labels).join('、');
}

function buildUserQueryProcess(traceEvents: unknown): QueryProcessStepDto[] {
  const events = toTraceEntries(traceEvents).sort((a, b) => {
    const left = typeof a.timestamp === 'string' ? Date.parse(a.timestamp) : 0;
    const right = typeof b.timestamp === 'string' ? Date.parse(b.timestamp) : 0;
    return left - right;
  });

  const steps: QueryProcessStepDto[] = [];

  for (const event of events) {
    const timestamp =
      typeof event.timestamp === 'string'
        ? event.timestamp
        : new Date().toISOString();

    if (event.type === 'xuanxue_policy_resolved') {
      const forceNames = asStringArray(event.forceSkillNames);
      const forceDirs = asStringArray(event.forceSkillDirs);
      const queryNames = asStringArray(event.queryableSkillNames);
      const queryDirs = asStringArray(event.queryableSkillDirs);
      const forced = formatSkillList(forceNames, forceDirs);
      const queryable = formatSkillList(queryNames, queryDirs);
      const detail = [
        forced ? `直接应用：${forced}` : null,
        queryable ? `可查章节：${queryable}` : null,
      ]
        .filter(Boolean)
        .join('；');
      if (detail) {
        steps.push({
          type: 'matched_skills',
          timestamp,
          title: '命中知识库',
          detail,
        });
      }
      continue;
    }

    if (event.type === 'xuanxue_interpretation_started') {
      const queryText =
        typeof event.queryText === 'string' ? event.queryText : undefined;
      steps.push({
        type: 'interpretation_start',
        timestamp,
        title: '开始解读',
        detail: queryText ? `解读问题：${queryText}` : undefined,
        queryText,
      });
      continue;
    }

    if (event.type === 'tool_call') {
      const tool = typeof event.toolName === 'string' ? event.toolName : '';
      if (
        tool !== 'list_knowledge_sections' &&
        tool !== 'read_knowledge_section'
      ) {
        continue;
      }
      const toolArgs =
        event.args && typeof event.args === 'object'
          ? (event.args as Record<string, unknown>)
          : {};
      const skillDir =
        typeof toolArgs.skill_dir === 'string' ? toolArgs.skill_dir : undefined;
      const skillName =
        typeof event.skillName === 'string' ? event.skillName : undefined;
      const skillLabel = skillName || skillDir;
      const sectionTitle =
        typeof toolArgs.section_title === 'string'
          ? toolArgs.section_title
          : undefined;

      if (tool === 'list_knowledge_sections') {
        steps.push({
          type: 'view_index',
          timestamp,
          title: '查看知识目录',
          detail: skillLabel ? `范围：${skillLabel}` : '查看可用章节',
          skillDir,
          skillName,
        });
        continue;
      }

      if (tool === 'read_knowledge_section' && sectionTitle) {
        steps.push({
          type: 'read_section',
          timestamp,
          title: '查阅章节',
          detail: skillLabel ? `${skillLabel} / ${sectionTitle}` : sectionTitle,
          skillDir,
          skillName,
          sectionTitle,
        });
      }
      continue;
    }

    if (
      event.type === 'tool_result' &&
      typeof event.toolName === 'string' &&
      ['interpret_xuanxue', 'final_reply'].includes(event.toolName)
    ) {
      steps.push({
        type: 'completed',
        timestamp,
        title:
          event.toolName === 'interpret_xuanxue'
            ? '解读材料已准备'
            : '完成解读',
      });
      continue;
    }
  }

  return steps;
}

export async function chatSessionsRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/chat-sessions — 列出当前用户的站内 AI Chat 会话
  app.get('/', async (request, reply) => {
    await request.requireAuth();
    const result = await listChatSessionsForOwnedUser(request.user.userId);
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // POST /api/chat-sessions — 创建当前用户的站内 AI Chat 会话
  app.post<{
    Body: { title?: string };
  }>('/', async (request, reply) => {
    await request.requireAuth();
    const title = (request.body?.title || '').trim();
    const result = await createChatSessionForOwnedUser(
      request.user.userId,
      title,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // PATCH /api/chat-sessions/s/:sessionId — 更新会话标题
  app.patch<{
    Params: { sessionId: string };
    Body: { title: string };
  }>('/s/:sessionId', async (request, reply) => {
    await request.requireAuth();
    const title = request.body?.title?.trim();
    if (!title) {
      return reply.code(400).send({ error: '标题不能为空' });
    }
    const result = await renameOwnedChatSession(
      request.user.userId,
      request.params.sessionId,
      title,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // DELETE /api/chat-sessions/s/:sessionId — 删除会话
  app.delete<{
    Params: { sessionId: string };
  }>('/s/:sessionId', async (request, reply) => {
    await request.requireAuth();
    const result = await deleteOwnedChatSession(
      request.user.userId,
      request.params.sessionId,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/chat-sessions/s/:sessionId/messages — 获取会话消息
  app.get<{
    Params: { sessionId: string };
    Querystring: { limit?: string; before?: string };
  }>('/s/:sessionId/messages', async (request, reply) => {
    await request.requireAuth();
    const limit = Math.min(
      parseInt(request.query.limit || '50', 10) || 50,
      200,
    );
    const result = await getOwnedChatSessionMessages(
      request.user.userId,
      request.params.sessionId,
      limit,
      request.query.before || undefined,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });

  // GET /api/chat-sessions/s/:sessionId/messages/:messageId/query-process — 用户态查询过程（脱敏）
  app.get<{
    Params: { sessionId: string; messageId: string };
  }>(
    '/s/:sessionId/messages/:messageId/query-process',
    async (request, reply) => {
      await request.requireAuth();
      const result = await getOwnedChatSessionQueryProcessSource(
        request.user.userId,
        request.params.sessionId,
        request.params.messageId,
      );
      if (!result.ok) {
        return reply.code(result.statusCode).send({ error: result.error });
      }
      if (!result.data.available || result.data.request_id == null) {
        return toQueryProcessResponseDto({
          available: false,
          request_id: null,
          timeline: [],
        });
      }
      const timeline = buildUserQueryProcess(result.data.trace_events);
      return toQueryProcessResponseDto({
        available: timeline.length > 0,
        request_id: result.data.request_id,
        timeline,
      });
    },
  );

  // POST /api/chat-sessions/s/:sessionId/messages — 发送消息
  app.post<{
    Params: { sessionId: string };
    Body: ChatSessionSendRequestDto;
  }>('/s/:sessionId/messages', async (request, reply) => {
    await request.requireAuth();
    const normalized = normalizeChatSessionMessageBody(request.body);
    if (!normalized.ok) {
      return reply
        .code(normalized.statusCode)
        .send({ error: normalized.error });
    }
    const result = await sendOwnedChatSessionMessage(
      request.user.userId,
      request.params.sessionId,
      normalized.data,
    );
    if (!result.ok) {
      return reply.code(result.statusCode).send({ error: result.error });
    }
    return result.data;
  });
}
