export interface MarkdownBlock {
  content: string;
  completed: boolean;
}

const LIST_MARKER = /^ {0,3}(?:[-+*][\t ]|\d{1,9}[.)][\t ])/;
const CONTAINER_CONTINUATION =
  /^(?:[\t ]|>|[-+*](?:[\t ]|$)|\d{1,9}[.)](?:[\t ]|$))/;

/**
 * Only commit blocks at unambiguous paragraph boundaries. Reference definitions
 * affect the entire document, and raw HTML can span blank lines, so either one
 * invalidates independent rendering. Lists stay together across loose items.
 */
export function splitMarkdownBlocks(content: string): MarkdownBlock[] {
  if (!content) return [];
  if (content.includes(']:') || /<[a-z!/?]/i.test(content)) {
    return [{ content, completed: false }];
  }

  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const nextContentLine: number[] = new Array(lines.length);
  let next = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    nextContentLine[index] = next;
    if (lines[index].trim()) next = index;
  }

  const blocks: MarkdownBlock[] = [];
  let offset = 0;
  let blockStart = 0;
  let hasContent = false;
  let inContainer = false;
  let fence: { marker: string; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.replace(/\r?\n$/, '');
    offset += rawLine.length;

    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[\t ]*$/);
      if (
        closing &&
        closing[1][0] === fence.marker &&
        closing[1].length >= fence.length
      ) {
        fence = null;
      }
      continue;
    }

    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
      fence = { marker: opening[1][0], length: opening[1].length };
      hasContent = true;
      continue;
    }

    if (line.trim()) {
      hasContent = true;
      if (LIST_MARKER.test(line) || /^ {0,3}>|^(?: {4}|\t)/.test(line)) {
        inContainer = true;
      }
      continue;
    }

    if (!hasContent || !rawLine.endsWith('\n')) continue;
    const following = nextContentLine[index];
    if (
      inContainer &&
      (following === -1 || CONTAINER_CONTINUATION.test(lines[following]))
    ) {
      continue;
    }

    blocks.push({
      content: content.slice(blockStart, offset),
      completed: true,
    });
    blockStart = offset;
    hasContent = false;
    inContainer = false;
  }

  if (blockStart < content.length) {
    blocks.push({ content: content.slice(blockStart), completed: false });
  }

  return blocks;
}
