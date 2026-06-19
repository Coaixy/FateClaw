/**
 * 话术稿(卦师念给客户的解读稿)解析工具。
 *
 * 背景:AI 在「基于盘面的玄学解读」时,会按固定 Markdown ## 章节输出话术稿
 * (见 agent-runtime 的 resource-loader.ts 话术稿骨架):
 *   ## 核心论断 / ## 分项解读 / ## 时机提示 / ## 给客户的建议 / ## ⚠分寸提示
 * 其中「分寸提示」是给卦师的内部参考,不可交付给客户。
 *
 * 后端把整段话术稿作为纯文本存在 message.content;本模块在前端把它解析成分节
 * 结构,供渲染成可折叠卡片,并支持「剔除仅卦师可见节」后导出给客户。
 * 解析放前端而非后端:后端 content 是单段纯文本,且解析口径(命中阈值、内部节
 * 识别)属于前端展示策略,随 UI 迭代,不宜固化进存储。
 */

/** 话术稿的一个章节。 */
export interface GuashiScriptSection {
  /** 章节标题(## 后的整行文本,已 trim,保留可能的 emoji 与 —— 说明)。 */
  title: string;
  /** 章节正文(标题行之后、下一个 ## 之前的 Markdown 原文)。 */
  body: string;
  /** 是否仅卦师可见(如「分寸提示」);为 true 时导出给客户的版本会剔除本节。 */
  guashiOnly: boolean;
}

/** 解析后的话术稿。 */
export interface GuashiScript {
  /** 第一个 ## 之前的内容(通常为空;有则作为开场白整体渲染)。 */
  preamble: string;
  /** 各章节,按出现顺序。 */
  sections: GuashiScriptSection[];
}

/** 匹配二级标题行 `## 标题`(用前瞻排除 ### 三级标题)。 */
const H2_LINE = /^##(?!#)\s+(.+?)\s*$/;

/** 匹配 Markdown 代码围栏 ```;围栏内的 ## 不应被当作章节标题。 */
const FENCE_LINE = /^\s*```/;

/**
 * 判定某章节是否「仅卦师可见」(不可导出给客户)。
 *
 * 话术稿模板现已交给卦师自定义,内部节不再绑定固定章节名,改为识别「约定标记」:
 * 标题带「⚠」「[仅卦师]」或含「分寸/仅供卦师/内部提示」等词即视为内部提示。
 * 此处刻意从宽:宁可多判为内部、也不要把内部话误导出给客户(误放比误删更严重)。
 */
export function isGuashiOnlySection(title: string): boolean {
  return /分寸|仅供卦师|仅卦师|卦师参考|内部提示|⚠/.test(title);
}

/**
 * 判定解析出的章节标题列表是否构成一份「话术稿」——决定是否启用分节卡片渲染。
 *
 * 话术稿模板已交给卦师自定义,章节名不再固定,故不能再按已知关键词命中。
 * 口径放宽为:最终解读消息里出现 ≥2 个 Markdown ## 章节即认定为话术稿;
 * 普通追问/澄清类回复一般只有 0~1 个 ## 标题,会自然回退到普通渲染。
 */
function looksLikeGuashiScript(titles: string[]): boolean {
  return titles.length >= 2;
}

/** 由扫描中累积的标题与正文行构造一个章节。 */
function buildSection(title: string, bodyLines: string[]): GuashiScriptSection {
  return {
    title,
    body: bodyLines.join('\n').trim(),
    guashiOnly: isGuashiOnlySection(title),
  };
}

/**
 * 把一段话术稿纯文本解析为分节结构。
 *
 * @param content 已去除 final marker 的消息正文(Markdown 纯文本)。
 * @returns 命中话术稿结构时返回解析结果;否则返回 null,调用方应回退到普通 Markdown 渲染
 *   (这样普通追问/澄清类回复不会被强行套上分节卡片)。
 */
export function parseGuashiScript(content: string): GuashiScript | null {
  const lines = content.split('\n');
  const sections: GuashiScriptSection[] = [];
  const preambleLines: string[] = [];
  // current 为 null 表示尚未遇到任何 ## 标题,此时内容归入 preamble。
  let currentTitle: string | null = null;
  let currentBody: string[] = [];
  let inFence = false;

  for (const line of lines) {
    // 进出代码围栏:围栏内的 ## 是代码内容,不能当章节标题(防御 AI 偶发输出代码块)。
    if (FENCE_LINE.test(line)) inFence = !inFence;
    const match = inFence ? null : H2_LINE.exec(line);

    if (match) {
      // 遇到新标题,先收尾上一节。
      if (currentTitle !== null) {
        sections.push(buildSection(currentTitle, currentBody));
      }
      currentTitle = match[1].trim();
      currentBody = [];
    } else if (currentTitle !== null) {
      currentBody.push(line);
    } else {
      preambleLines.push(line);
    }
  }
  // 收尾最后一节。
  if (currentTitle !== null) {
    sections.push(buildSection(currentTitle, currentBody));
  }

  // 命中判定:不像话术稿就回退普通渲染。
  if (!looksLikeGuashiScript(sections.map((section) => section.title))) {
    return null;
  }

  return {
    preamble: preambleLines.join('\n').trim(),
    sections,
  };
}

/**
 * 取章节标题里交付给客户的主名,去掉 `——` 后面给卦师看的元提示说明。
 *
 * 骨架标题形如「核心论断 —— 先给客户最关心的一句话结论」,—— 后是写作指引、不是给
 * 客户的内容,导出时应去掉。按「空格 + 1~2 个 破折号/连字符 + 空格」切分,避免误伤词内连字符。
 */
function sectionTitleForClient(title: string): string {
  return title.split(/\s+[—-]{1,2}\s+/)[0].trim();
}

/**
 * 把 Markdown 文本转成干净的纯文本,供导出给客户。
 *
 * 卦师复制给客户的是聊天纯文本(微信等),不该出现 # * ` > [] 等 Markdown 记号。
 * 按行剥离块级标记(标题/引用/列表/分割线/代码围栏),再行内剥离强调/代码/链接标记。
 * 无序列表项转为「· 」保留分项可读性;有序列表「1. 」是自然表达,保留。
 * 注:话术稿正文以中文段落与简单列表为主,用正则覆盖常见标记即可,不追求完备解析。
 */
function markdownToPlainText(markdown: string): string {
  const lines = markdown.split('\n').map((line) => {
    // 代码围栏整行丢弃。
    if (/^\s*```/.test(line)) return '';
    // 分割线(--- *** ___)整行丢弃。
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return '';
    return (
      line
        // 行首标题记号 #。
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        // 行首引用记号 >。
        .replace(/^\s{0,3}>\s?/, '')
        // 行首无序列表记号 - * + → 中文项目符号「· 」。
        .replace(/^(\s*)[-*+]\s+/, '$1· ')
    );
  });

  return (
    lines
      .join('\n')
      // 行内:先粗体再斜体(避免单个 * 先吞掉 **),再删除线/行内代码/链接。
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/~~([^~]+)~~/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      // 链接 [文字](url) → 只留文字。
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // 压缩剥离后产生的多余空行。
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

/**
 * 生成「交付给客户」的纯文本:剔除仅卦师可见的章节,其余按「标题 + 正文」拼接。
 *
 * 供卦师一键复制后粘贴发给客户。标题用客户版主名(去掉给卦师的元提示),正文与标题
 * 都经 markdownToPlainText 剥离 Markdown 记号,确保客户看到的是干净纯文本。
 */
export function buildClientDeliveryText(script: GuashiScript): string {
  const parts: string[] = [];
  if (script.preamble) parts.push(markdownToPlainText(script.preamble));
  for (const section of script.sections) {
    if (section.guashiOnly) continue; // 分寸提示等内部章节不交付客户
    const title = markdownToPlainText(sectionTitleForClient(section.title));
    const body = markdownToPlainText(section.body);
    parts.push(body ? `${title}\n${body}` : title);
  }
  return parts.join('\n\n').trim();
}
