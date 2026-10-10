import sharp from 'sharp';
import { loadEnv } from '../config/env';

type AnthropicBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image';
      source: { type: 'base64'; media_type: string; data: string };
    }
  | { type: string; [k: string]: unknown };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicParams {
  model?: string;
  max_tokens?: number;
  system?: string | { type: string; text?: string }[];
  messages: AnthropicMessage[];
  temperature?: number;
  output_config?: {
    format?: { type: string; schema?: Record<string, unknown> };
  };
}

type OpenAiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatRequest {
  model: string;
  messages: { role: string; content: string | OpenAiPart[] }[];
  max_tokens: number;
  temperature: number;
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; schema: Record<string, unknown> };
  };
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: { message: { content: string | null }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class InvalidRequest extends Error {}

function cleanSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanSchema);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === '$schema') continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

async function imageParts(mediaType: string, data: string) {
  const env = loadEnv();
  const buffer = Buffer.from(data, 'base64');
  const meta = await sharp(buffer).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height || height <= width * env.llmSliceAspect) {
    return [{ url: `data:${mediaType};base64,${data}`, label: null }];
  }
  const sliceHeight = Math.max(64, Math.round(width * env.llmSliceRatio));
  const step = Math.max(32, Math.round(sliceHeight * 0.9));
  const starts: number[] = [];
  for (let y = 0; y + sliceHeight < height; y += step) starts.push(y);
  starts.push(Math.max(0, height - sliceHeight));
  const unique = [...new Set(starts)];
  return Promise.all(
    unique.map(async (top, i) => {
      const slice = await sharp(buffer)
        .extract({
          left: 0,
          top,
          width,
          height: Math.min(sliceHeight, height - top),
        })
        .webp({ quality: 92 })
        .toBuffer();
      return {
        url: `data:image/webp;base64,${slice.toString('base64')}`,
        label: `(part ${i + 1} of ${unique.length}, top to bottom, slightly overlapping)`,
      };
    }),
  );
}

async function convertContent(
  content: string | AnthropicBlock[],
): Promise<string | OpenAiPart[]> {
  if (typeof content === 'string') return content;
  const parts: OpenAiPart[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      const source = (
        block as {
          source?: { type?: string; media_type?: string; data?: string };
        }
      ).source;
      if (source?.type !== 'base64' || !source.data) {
        throw new InvalidRequest('Só imagens em base64 são aceitas.');
      }
      for (const part of await imageParts(
        source.media_type ?? 'image/webp',
        source.data,
      )) {
        if (part.label) parts.push({ type: 'text', text: part.label });
        parts.push({ type: 'image_url', image_url: { url: part.url } });
      }
    } else {
      throw new InvalidRequest(`Bloco "${block.type}" não suportado.`);
    }
  }
  return parts;
}

export async function toChatRequest(
  params: AnthropicParams,
): Promise<ChatRequest> {
  const env = loadEnv();
  if (!params || !Array.isArray(params.messages) || !params.messages.length) {
    throw new InvalidRequest('Pedido sem mensagens.');
  }
  const messages: ChatRequest['messages'] = [];
  const system =
    typeof params.system === 'string'
      ? params.system
      : (params.system ?? [])
          .map((b) => b.text ?? '')
          .filter(Boolean)
          .join('\n\n');
  if (system) messages.push({ role: 'system', content: system });
  for (const m of params.messages) {
    messages.push({ role: m.role, content: await convertContent(m.content) });
  }
  const schema = params.output_config?.format?.schema;
  return {
    model: env.llmModel,
    messages,
    max_tokens: Math.min(
      params.max_tokens ?? env.llmMaxTokens,
      env.llmMaxTokens,
    ),
    temperature: params.temperature ?? env.llmTemperature,
    ...(params.output_config?.format?.type === 'json_schema' && schema
      ? {
          response_format: {
            type: 'json_schema' as const,
            json_schema: {
              name: 'output',
              schema: cleanSchema(schema) as Record<string, unknown>,
            },
          },
        }
      : {}),
  };
}

export function toAnthropicMessage(res: ChatResponse) {
  const choice = res.choices[0];
  const reason = choice?.finish_reason;
  return {
    id: `msg_gpu_${res.id}`,
    type: 'message',
    role: 'assistant',
    model: res.model,
    content: [
      { type: 'text', text: choice?.message.content ?? '', citations: null },
    ],
    stop_reason: reason === 'length' ? 'max_tokens' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}
