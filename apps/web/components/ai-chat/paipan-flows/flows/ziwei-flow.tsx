'use client';

import { BaziFlow } from './bazi-flow';
import type { PaipanFlowProps } from '../types';

/**
 * 紫微斗数排盘的新手引导填写 flow。
 *
 * @param props 外层弹窗注入的 draft、字段组件、辅助函数和变更回调。
 * @returns 复用出生信息步骤的紫微排盘表单；保留独立出口便于后续扩展紫微专属步骤。
 */
export function ZiweiFlow(props: PaipanFlowProps) {
  return <BaziFlow {...props} enableGanzhiReverse={false} />;
}
