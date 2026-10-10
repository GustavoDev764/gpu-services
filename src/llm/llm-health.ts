import { loadEnv } from '../config/env';

export interface LlmHealth {
  status: 'disabled' | 'ready' | 'loading';
  model: string | null;
  maxContext: number | null;
  error: string | null;
}

export async function llmHealth(): Promise<LlmHealth> {
  const env = loadEnv();
  if (!env.llmEnabled) {
    return { status: 'disabled', model: null, maxContext: null, error: null };
  }
  try {
    const res = await fetch(`${env.llmUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: { id: string; max_model_len?: number }[];
    };
    const model =
      body.data?.find((m) => m.id === env.llmModel) ?? body.data?.[0];
    return {
      status: model ? 'ready' : 'loading',
      model: model?.id ?? null,
      maxContext: model?.max_model_len ?? null,
      error: null,
    };
  } catch (err) {
    return {
      status: 'loading',
      model: null,
      maxContext: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
