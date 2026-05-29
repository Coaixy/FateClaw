'use client';

import { IchingFlow } from './iching-flow';
import type { PaipanFlowProps } from '../types';

/**
 * 经占排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 复用起卦步骤的经占排盘表单；保留独立出口便于后续扩展经占专属文案。
 */
export function JingzhanFlow(props: PaipanFlowProps) {
  return <IchingFlow {...props} />;
}
