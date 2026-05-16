import { isUserPastedBoardSkill, type UserPastedBoardArtifactData } from '../../../pasted-board-context.js';
import { formatBaziBoard } from './bazi.js';
import { formatLiuyaoBoard, formatJingzhanBoard } from './iching.js';
import { formatQimenBoard } from './qimen.js';
import { formatZiweiBoard } from './ziwei.js';
import {
  asRecord,
  BoardFormatError,
  parseBoardPayload,
  stringifyPayloadForError,
} from './common.js';

const FORMATTERS: Record<string, (payload: unknown) => string> = {
  'bazi-paipan': formatBaziBoard,
  'ziwei-paipan': formatZiweiBoard,
  'iching-paipan': formatLiuyaoBoard,
  'jingzhan-paipan': formatJingzhanBoard,
  'qimen-paipan': formatQimenBoard,
};

export { BoardFormatError };

export function hasBoardFormatter(skill: string): boolean {
  return Boolean(FORMATTERS[skill]) || isUserPastedBoardSkill(skill);
}

export function formatBoardForAi(args: {
  skill: string;
  output: string;
  artifactData?: unknown;
}): string {
  if (isUserPastedBoardSkill(args.skill)) {
    const payload = parseBoardPayload(args);
    const record = asRecord(
      args.skill,
      payload,
      'payload',
    ) as unknown as UserPastedBoardArtifactData;
    if (typeof record.content !== 'string' || !record.content.trim()) {
      throw new BoardFormatError(args.skill, '自贴盘面缺少 content');
    }
    return record.content;
  }

  const formatter = FORMATTERS[args.skill];
  if (!formatter) {
    throw new BoardFormatError(args.skill, '未配置官方排盘 AI 摘要 formatter');
  }

  const payload = parseBoardPayload(args);
  try {
    return formatter(payload);
  } catch (error) {
    if (error instanceof BoardFormatError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new BoardFormatError(
      args.skill,
      `生成 AI 摘要失败: ${detail}; payload=${stringifyPayloadForError(payload).slice(0, 500)}`,
    );
  }
}
