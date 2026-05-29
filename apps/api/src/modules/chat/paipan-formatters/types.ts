/** 将排盘结构化结果转换为 Pi Runtime 可直接阅读的盘面文本。 */
export type PaipanFormatter = (artifactData: unknown) => string;
