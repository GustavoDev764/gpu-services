import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Job, Worker } from 'bullmq';
import { createHmac, randomBytes } from 'node:crypto';
import { ClientsService } from '../auth/clients.service';
import { loadEnv } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import {
  bullConnection,
  key,
  QUEUES,
  RedisService,
} from '../redis/redis.service';

interface Delivery {
  jobId: string;
  attempt: number;
}

export function sign(secret: string, timestamp: number, body: string) {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

@Injectable()
export class WebhookService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('webhook');
  private worker?: Worker<Delivery>;

  constructor(
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
    private readonly clients: ClientsService,
  ) {}

  onApplicationBootstrap() {
    this.worker = new Worker<Delivery>(
      QUEUES.webhook,
      (job) => this.deliver(job),
      {
        connection: bullConnection(),
        prefix: loadEnv().queuePrefix,
        concurrency: 8,
      },
    );
    this.worker.on('error', (err) => this.log.error(err.message));
  }

  async onModuleDestroy() {
    await this.worker?.close();
  }

  private async deliver(job: Job<Delivery>) {
    const env = loadEnv();
    const { jobId, attempt } = job.data;
    const row = await this.redis.client.hgetall(key('job', jobId));
    if (!row.id || !row.callbackUrl) return;
    const client = await this.clients.byId(row.client);
    if (!client) return;
    const summary = this.jobs.summary(row);
    const body = JSON.stringify({
      event: 'job.finished',
      ...summary,
      files: row.type === 'inpaint' ? Number(row.done ?? 0) : 0,
    });
    const timestamp = Math.floor(Date.now() / 1000);
    const deliveryId = `d_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
    const startedAt = Date.now();
    let status = 0;
    let error = '';
    try {
      const res = await fetch(row.callbackUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-gpu-event': 'job.finished',
          'x-gpu-delivery': deliveryId,
          'x-gpu-timestamp': String(timestamp),
          'x-gpu-signature': sign(client.secret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(env.webhookTimeoutMs),
      });
      status = res.status;
      await res.arrayBuffer().catch(() => undefined);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const ok = status >= 200 && status < 300;
    const next = ok ? null : env.webhookDelaysMs[attempt - 1];
    const record = {
      id: deliveryId,
      attempt,
      status,
      error: error || null,
      ms: Date.now() - startedAt,
      at: new Date(startedAt).toISOString(),
      nextInMs: next ?? null,
    };
    const deliveries = key('job', jobId, 'deliveries');
    await this.redis.client
      .multi()
      .rpush(deliveries, JSON.stringify(record))
      .expire(deliveries, env.jobTtlSeconds)
      .hset(
        key('job', jobId),
        'webhook',
        ok
          ? 'delivered'
          : next === undefined || next === null
            ? 'failed'
            : 'retrying',
      )
      .exec();
    if (ok) {
      this.log.log(
        `${jobId}: webhook entregue (tentativa ${attempt}, HTTP ${status})`,
      );
      return;
    }
    if (next === undefined || next === null) {
      this.log.warn(
        `${jobId}: webhook não entregue depois de ${attempt} tentativas (${error || `HTTP ${status}`})`,
      );
      return;
    }
    this.log.warn(
      `${jobId}: webhook falhou (${error || `HTTP ${status}`}), nova tentativa em ${Math.round(next / 1000)}s`,
    );
    await this.jobs.queues.webhook.add(
      'deliver',
      { jobId, attempt: attempt + 1 },
      { delay: next, removeOnComplete: true, removeOnFail: true },
    );
  }
}
