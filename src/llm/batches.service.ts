import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import { randomBytes } from 'node:crypto';
import type { Client } from '../auth/clients.service';
import { loadEnv } from '../config/env';
import { bullConnection, key, RedisService } from '../redis/redis.service';
import {
  InvalidRequest,
  toAnthropicMessage,
  toChatRequest,
  type AnthropicParams,
  type ChatRequest,
  type ChatResponse,
} from './convert';

export const LLM_QUEUE = 'gpu-llm';
const MAX_REQUESTS = 1000;

interface LlmJob {
  batchId: string;
  customId: string;
}

type StoredResult =
  | { type: 'succeeded'; message: unknown }
  | { type: 'errored'; error: string }
  | { type: 'canceled' };

const iso = (v?: string) => (v ? new Date(Number(v)).toISOString() : null);

@Injectable()
export class BatchesService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('llm');
  readonly queue: Queue<LlmJob>;
  private worker?: Worker<LlmJob>;

  constructor(private readonly redis: RedisService) {
    this.queue = new Queue<LlmJob>(LLM_QUEUE, {
      connection: bullConnection(),
      prefix: loadEnv().queuePrefix,
    });
  }

  onApplicationBootstrap() {
    const env = loadEnv();
    if (!env.llmEnabled) return;
    this.worker = new Worker<LlmJob>(LLM_QUEUE, (job) => this.process(job), {
      connection: bullConnection(),
      prefix: env.queuePrefix,
      concurrency: env.llmConcurrency,
      lockDuration: env.llmTimeoutMs + 60_000,
    });
    this.worker.on('error', (err) => this.log.error(err.message));
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue.close();
  }

  private k(id: string, part?: string) {
    return part ? key('batch', id, part) : key('batch', id);
  }

  async create(client: Client, requests: unknown) {
    const env = loadEnv();
    if (!env.llmEnabled) {
      throw new BadRequestException(
        'Tradução por LLM desligada neste servidor (LLM_ENABLED).',
      );
    }
    if (!Array.isArray(requests) || !requests.length) {
      throw new BadRequestException(
        'Envie "requests": [{ custom_id, params }].',
      );
    }
    if (requests.length > MAX_REQUESTS) {
      throw new BadRequestException(
        `No máximo ${MAX_REQUESTS} pedidos por lote.`,
      );
    }
    const ids = new Set<string>();
    for (const r of requests as { custom_id?: unknown; params?: unknown }[]) {
      if (typeof r?.custom_id !== 'string' || !r.custom_id) {
        throw new BadRequestException('Cada pedido precisa de custom_id.');
      }
      if (ids.has(r.custom_id)) {
        throw new BadRequestException(`custom_id repetido: ${r.custom_id}`);
      }
      if (!r.params || typeof r.params !== 'object') {
        throw new BadRequestException(`Pedido ${r.custom_id} sem params.`);
      }
      ids.add(r.custom_id);
    }
    const id = `msgbatch_gpu_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
    const list = requests as { custom_id: string; params: unknown }[];
    const ttl = env.jobTtlSeconds;
    const multi = this.redis.client.multi();
    multi.hset(this.k(id), {
      id,
      client: client.id,
      status: 'in_progress',
      total: String(list.length),
      succeeded: '0',
      errored: '0',
      canceled: '0',
      createdAt: String(Date.now()),
    });
    multi.hset(
      this.k(id, 'req'),
      Object.fromEntries(
        list.map((r) => [r.custom_id, JSON.stringify(r.params)]),
      ),
    );
    multi.rpush(this.k(id, 'order'), ...list.map((r) => r.custom_id));
    for (const part of [undefined, 'req', 'order'])
      multi.expire(this.k(id, part), ttl);
    await multi.exec();
    await this.queue.addBulk(
      list.map((r, i) => ({
        name: 'request',
        data: { batchId: id, customId: r.custom_id },
        opts: {
          jobId: `${id}-${i}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    );
    this.log.log(`${id}: ${list.length} pedidos na fila`);
    return this.info(await this.raw(id, client));
  }

  async raw(id: string, client: Client) {
    const row = await this.redis.client.hgetall(this.k(id));
    if (!row.id || row.client !== client.id) {
      throw new NotFoundException('Lote não encontrado.');
    }
    return row;
  }

  info(row: Record<string, string>) {
    const total = Number(row.total);
    const succeeded = Number(row.succeeded ?? 0);
    const errored = Number(row.errored ?? 0);
    const canceled = Number(row.canceled ?? 0);
    const ttl = loadEnv().jobTtlSeconds * 1000;
    return {
      id: row.id,
      type: 'message_batch',
      processing_status: row.status,
      request_counts: {
        processing: Math.max(0, total - succeeded - errored - canceled),
        succeeded,
        errored,
        canceled,
        expired: 0,
      },
      created_at: iso(row.createdAt),
      ended_at: iso(row.endedAt),
      expires_at: new Date(Number(row.createdAt) + ttl).toISOString(),
    };
  }

  async retrieve(id: string, client: Client) {
    return this.info(await this.raw(id, client));
  }

  async results(id: string, client: Client) {
    const row = await this.raw(id, client);
    if (row.status !== 'ended') {
      throw new BadRequestException('O lote ainda não terminou.');
    }
    const order = await this.redis.client.lrange(this.k(id, 'order'), 0, -1);
    const stored = await this.redis.client.hgetall(this.k(id, 'res'));
    return order.map((customId) => {
      const r = stored[customId]
        ? (JSON.parse(stored[customId]) as StoredResult)
        : ({ type: 'canceled' } as StoredResult);
      if (r.type === 'succeeded') {
        return {
          custom_id: customId,
          result: { type: 'succeeded', message: r.message },
        };
      }
      if (r.type === 'errored') {
        return {
          custom_id: customId,
          result: {
            type: 'errored',
            error: {
              type: 'error',
              error: { type: 'api_error', message: r.error },
            },
          },
        };
      }
      return { custom_id: customId, result: { type: 'canceled' } };
    });
  }

  async cancel(id: string, client: Client) {
    const row = await this.raw(id, client);
    if (row.status === 'ended') return this.info(row);
    await this.redis.client.hset(this.k(id), 'status', 'canceling');
    const order = await this.redis.client.lrange(this.k(id, 'order'), 0, -1);
    for (const [i, customId] of order.entries()) {
      const job = await this.queue.getJob(`${id}-${i}`);
      if (job && !(await job.isActive())) {
        await job.remove().catch(() => undefined);
        await this.store(id, customId, { type: 'canceled' });
      }
    }
    await this.maybeEnd(id);
    return this.info(await this.raw(id, client));
  }

  async purge(id: string, client: Client) {
    await this.raw(id, client);
    await this.redis.client.del(
      this.k(id),
      this.k(id, 'req'),
      this.k(id, 'order'),
      this.k(id, 'res'),
    );
    return { id, status: 'deleted' as const };
  }

  private async store(id: string, customId: string, result: StoredResult) {
    const field = result.type === 'succeeded' ? 'succeeded' : result.type;
    const created = await this.redis.client.hsetnx(
      this.k(id, 'res'),
      customId,
      JSON.stringify(result),
    );
    if (!created) return;
    await this.redis.client
      .multi()
      .hincrby(this.k(id), field, 1)
      .hdel(this.k(id, 'req'), customId)
      .expire(this.k(id, 'res'), loadEnv().jobTtlSeconds)
      .exec();
    await this.maybeEnd(id);
  }

  private async maybeEnd(id: string) {
    const row = await this.redis.client.hgetall(this.k(id));
    if (!row.id || row.status === 'ended') return;
    const done =
      Number(row.succeeded) + Number(row.errored) + Number(row.canceled);
    if (done < Number(row.total)) return;
    const ended = await this.redis.client.hsetnx(
      this.k(id),
      'endedAt',
      String(Date.now()),
    );
    await this.redis.client.hset(this.k(id), 'status', 'ended');
    if (ended) {
      const secs = (Date.now() - Number(row.createdAt)) / 1000;
      this.log.log(
        `${id}: terminou em ${secs.toFixed(1)}s (${row.succeeded} ok, ${row.errored} com erro, ${row.canceled} cancelados)`,
      );
    }
  }

  private async complete(request: ChatRequest): Promise<ChatResponse> {
    const env = loadEnv();
    const res = await fetch(`${env.llmUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(env.llmTimeoutMs),
    });
    const text = await res.text();
    if (res.status >= 400 && res.status < 500) {
      throw new UnrecoverableError(
        `vLLM recusou o pedido (HTTP ${res.status}): ${text.slice(0, 300)}`,
      );
    }
    if (!res.ok)
      throw new Error(`vLLM HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as ChatResponse;
  }

  private async process(job: Job<LlmJob>) {
    const { batchId, customId } = job.data;
    const row = await this.redis.client.hgetall(this.k(batchId));
    if (!row.id || row.status === 'ended') return;
    if (await this.redis.client.hexists(this.k(batchId, 'res'), customId))
      return;
    if (row.status === 'canceling') {
      await this.store(batchId, customId, { type: 'canceled' });
      return;
    }
    const raw = await this.redis.client.hget(this.k(batchId, 'req'), customId);
    if (!raw) {
      await this.store(batchId, customId, {
        type: 'errored',
        error: 'Pedido não encontrado.',
      });
      return;
    }
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    try {
      const request = await toChatRequest(JSON.parse(raw) as AnthropicParams);
      let res = await this.complete(request);
      if (res.choices[0]?.finish_reason === 'length') {
        this.log.warn(
          `${batchId}/${customId}: passou de ${request.max_tokens} tokens (provável repetição); tentando de novo com penalidade maior`,
        );
        res = await this.complete({
          ...request,
          repetition_penalty: 1.2,
          temperature: 0.6,
        });
      }
      if (res.choices[0]?.finish_reason === 'length') {
        throw new UnrecoverableError(
          `O Gemma entrou em repetição e passou de ${request.max_tokens} tokens duas vezes.`,
        );
      }
      const message = toAnthropicMessage(res);
      await this.store(batchId, customId, { type: 'succeeded', message });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        err instanceof InvalidRequest ||
        err instanceof UnrecoverableError ||
        final
      ) {
        this.log.warn(`${batchId}/${customId}: ${msg}`);
        await this.store(batchId, customId, { type: 'errored', error: msg });
        return;
      }
      throw err;
    }
  }
}
