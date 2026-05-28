import type { ModelPiApi } from './api';

export const PI_API_OPTIONS: Array<{
  value: ModelPiApi;
  label: string;
}> = [
  { value: 'openai-completions', label: 'openai-completions' },
  { value: 'openai-responses', label: 'openai-responses' },
  { value: 'anthropic-messages', label: 'anthropic-messages' },
  { value: 'google-generative-ai', label: 'google-generative-ai' },
];

export function protocolTypeLabel(value: ModelPiApi): string {
  return (
    PI_API_OPTIONS.find((option) => option.value === value)?.label ?? value
  );
}
