import type { ModelProviderType, OfficialModelConfig } from '#shared/types';

const DEFAULT_ORIGINS: Record<ModelProviderType, string> = {
  'openai-completions': 'https://api.openai.com',
  'openai-responses': 'https://api.openai.com',
  'anthropic-messages': 'https://api.anthropic.com',
  'google-generative-ai': 'https://generativelanguage.googleapis.com',
};

const STATUS_PROBE_TIMEOUT_MS = 8_000;

export function modelNetworkProbeOrigin({
  pi_api,
  base_url,
}: Pick<OfficialModelConfig, 'pi_api' | 'base_url'>): string | null {
  const url = URL.parse(base_url ?? DEFAULT_ORIGINS[pi_api]);
  return url && (url.protocol === 'https:' || url.protocol === 'http:')
    ? url.origin
    : null;
}

export async function probeModelNetwork(
  origin: string,
  callerSignal: AbortSignal,
  timeoutMs = STATUS_PROBE_TIMEOUT_MS,
): Promise<number | null> {
  if (callerSignal.aborted) return null;
  const signal = AbortSignal.any([
    callerSignal,
    AbortSignal.timeout(timeoutMs),
  ]);
  const started = performance.now();
  try {
    // Any HTTP response confirms reachability, including gateway and auth errors.
    await fetch(origin, { method: 'HEAD', redirect: 'manual', signal });
    return signal.aborted ? null : Math.round(performance.now() - started);
  } catch {
    return null;
  }
}
