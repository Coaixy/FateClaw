'use client';

import type { PaipanFlowComponent, PaipanSkillId } from './types';
import { BaziFlow } from './flows/bazi-flow';
import { IchingFlow } from './flows/iching-flow';
import { JingzhanFlow } from './flows/jingzhan-flow';
import { LiurenFlow } from './flows/liuren-flow';
import { MeihuaFlow } from './flows/meihua-flow';
import { QimenFlow } from './flows/qimen-flow';
import { ZiweiFlow } from './flows/ziwei-flow';

export type {
  PaipanFlowChange,
  PaipanFlowFieldKit,
  PaipanFlowHelpers,
  PaipanFlowProps,
  PaipanSkillId,
} from './types';

const PAIPAN_FLOW_REGISTRY: Record<PaipanSkillId, PaipanFlowComponent> = {
  'bazi-paipan': BaziFlow,
  'ziwei-paipan': ZiweiFlow,
  'iching-paipan': IchingFlow,
  'jingzhan-paipan': JingzhanFlow,
  'meihua-paipan': MeihuaFlow,
  'liuren-paipan': LiurenFlow,
  'qimen-paipan': QimenFlow,
};

/**
 * 根据后端 catalog 返回的术数 key 查找对应的引导式填写 flow。
 *
 * @param skill 后端提供的内部术数 key。
 * @returns 已注册 flow 组件；未知术数返回 null，由外层回退到高级字段。
 */
export function resolvePaipanFlow(skill: string): PaipanFlowComponent | null {
  return PAIPAN_FLOW_REGISTRY[skill as PaipanSkillId] ?? null;
}
