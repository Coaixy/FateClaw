export type SkillEntry =
  | { type: 'script'; file: string }
  | { type: 'tool'; tool: string; fallbackScript?: string };

export interface SkillRuntimePayload {
  protocol_version: number;
  skill_name: string;
  display_name: string;
  requires_load: boolean;
  manifest_source: string;
  entry?: SkillEntry;
  parameter_signature?: string;
  parameters_schema?: unknown;
}

export interface SkillRuntimeGuidancePayload {
  protocol_version: number;
  skill_name: string;
  recommended_entry:
    | { type: 'script'; file: string }
    | { type: 'tool'; tool: string; fallbackScript?: string }
    | { type: 'knowledge_only' };
  notes: string[];
}

export interface ParsedSkillRuntimeProtocol {
  runtime: SkillRuntimePayload | null;
  guidance: SkillRuntimeGuidancePayload | null;
  guidanceText: string | null;
  remainingBody: string;
}

function extractTagBody(
  input: string,
  tagName: string,
): { body: string; fullMatch: string } | null {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    'i',
  );
  const match = input.match(pattern);
  if (!match) return null;
  return {
    body: match[1]?.trim() || '',
    fullMatch: match[0],
  };
}

function parseJsonBlock<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

export function parseSkillRuntimeProtocol(
  output: string,
): ParsedSkillRuntimeProtocol | null {
  if (!output.includes('<skill-runtime')) return null;

  const runtimeBlock = extractTagBody(output, 'skill-runtime');
  if (!runtimeBlock) return null;

  const guidanceBlock = extractTagBody(output, 'skill-runtime-guidance');
  const runtime = parseJsonBlock<SkillRuntimePayload>(runtimeBlock.body);

  let guidance: SkillRuntimeGuidancePayload | null = null;
  let guidanceText: string | null = null;
  if (guidanceBlock) {
    const [jsonPart, ...rest] = guidanceBlock.body.split('\n---\n');
    guidance = parseJsonBlock<SkillRuntimeGuidancePayload>(jsonPart.trim());
    guidanceText = rest.join('\n---\n').trim() || null;
  }

  let remainingBody = output.replace(runtimeBlock.fullMatch, '').trim();
  if (guidanceBlock) {
    remainingBody = remainingBody.replace(guidanceBlock.fullMatch, '').trim();
  }

  return {
    runtime,
    guidance,
    guidanceText,
    remainingBody,
  };
}
