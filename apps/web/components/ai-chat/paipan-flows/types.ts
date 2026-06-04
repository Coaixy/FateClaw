'use client';

import type { ComponentType, ReactNode } from 'react';

/**
 * 手动排盘前端使用的内置术数标识。
 *
 * 这些值只用于代码匹配 flow 和提交 API，不应直接展示给用户。
 */
export type PaipanSkillId =
  | 'bazi-paipan'
  | 'ziwei-paipan'
  | 'iching-paipan'
  | 'jingzhan-paipan'
  | 'meihua-paipan'
  | 'liuren-paipan'
  | 'qimen-paipan';

/**
 * flow 向外层 draft 提交的单个字段变更。
 */
export interface PaipanFlowChange {
  path: string[];
  value: unknown;
}

/**
 * 引导式选项网格的单个选项配置。
 */
export interface ChoiceGridOption {
  value: string;
  label: string;
  hint?: string;
  recommended?: boolean;
}

/**
 * 从旧排盘弹窗注入给 flow 的字段组件集合。
 *
 * 第一阶段通过依赖注入复用现有字段控件，避免拆 flow 时同时重写基础输入组件。
 */
export interface PaipanFlowFieldKit {
  DateField: ComponentType<{
    title: string;
    description?: string;
    required?: boolean;
    value: string;
    onChange: (value: string | undefined) => void;
  }>;
  TimeField: ComponentType<{
    title: string;
    description?: string;
    required?: boolean;
    hour: unknown;
    minute: unknown;
    onChange: (next: { hour?: number; minute?: number }) => void;
  }>;
  DateTimeField: ComponentType<{
    title: string;
    description?: string;
    required?: boolean;
    value: unknown;
    onChange: (value: string | undefined) => void;
  }>;
  ChoiceGrid: ComponentType<{
    title: string;
    description?: string;
    required?: boolean;
    value: string | undefined;
    options: ChoiceGridOption[];
    columns?: 2 | 3;
    onChange: (value: string) => void;
  }>;
  FieldTextInput: ComponentType<{
    title: string;
    required?: boolean;
    description?: string;
    value: string;
    placeholder?: string;
    onChange: (value: string | undefined) => void;
  }>;
}

/**
 * flow 需要复用的 draft 读写辅助函数。
 *
 * 这些函数由 `PaipanSheet` 提供，确保不同 flow 使用同一套时间、数组和路径处理规则。
 */
export interface PaipanFlowHelpers {
  getValueAtPath: (source: Record<string, unknown>, path: string[]) => unknown;
  normalizeGenderValue: (value: unknown) => '男' | '女' | undefined;
  getCurrentLocalDateParts: () => {
    date: string;
    hour: number;
    minute: number;
    dateTime: string;
  };
  fromDateTimeLocalValue: (value: string) => string | undefined;
  formatArrayInputValue: (value: unknown) => string;
  parseDelimitedArrayInput: (
    raw: string,
    itemType: 'integer' | 'number' | string,
  ) => unknown[] | undefined;
}

/**
 * 每个术数引导 flow 的公共 props。
 *
 * flow 只负责常用参数填写，不负责预览、提交、弹窗开关或高级参数。
 */
export interface PaipanFlowProps {
  draft: Record<string, unknown>;
  fieldKit: PaipanFlowFieldKit;
  helpers: PaipanFlowHelpers;
  onChange: (path: string[], value: unknown) => void;
  onManyChanges: (changes: PaipanFlowChange[]) => void;
  finalContent?: ReactNode;
  finalAction?: ReactNode;
  resultContent?: ReactNode;
  resultAction?: ReactNode;
  /**
   * 通知外层当前是否停在预览结果步骤，供弹层固定展示结果主操作。
   */
  onResultStepChange?: (isActive: boolean) => void;
}

/**
 * 单个术数的引导式填写组件类型。
 */
export type PaipanFlowComponent = ComponentType<PaipanFlowProps>;
