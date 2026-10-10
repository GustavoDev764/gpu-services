import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Client } from '../auth/clients.service';
import { loadEnv } from '../config/env';
import {
  bullConnection,
  key,
  QUEUES,
  RedisService,
} from '../redis/redis.service';

export type JobType = 'detect' | 'inpaint';
export type JobStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface JobInput {
  name: string;
  file: string;
  mask?: string;
}

export interface CreateJob {
  type: JobType;
  client: Client;
  inputs: { name: string; path: string; maskPath?: string }[];
  callbackUrl?: string;
  externalId?: string;
  priority?: string;
  params: Record<string, number | boolean>;
}

const PRIORITY = { high: 1, normal: 5 } as const;
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;

export const jobDir = (id: string) => join(loadEnv().dataDir, 'jobs', id);

function safeName(name: string, used: Set<string>) {
  const base =
    basename(name || 'imagem')
      .replace(/[^\w.-]+/g, '_')
      .slice(-120) || 'imagem';
  let out = base;
  for (let i = 2; used.has(out.toLowerCase()); i++)
    out = `${base.slice(0, base.length - extname(base).length)}-${i}${extname(base)}`;
  used.add(out.toLowerCase());
  return out;
}

const iso = (v?: string) => (v ? new Date(Number(v)).toISOString() : null);
const ms = (a?: string, b?: string) => (a && b ? Number(b) - Number(a) : null);

@Injectable()
export class JobsService implements OnModuleDestroy {
  readonly queues: Record<JobType | 'webhook', Queue>;

  constructor(private readonly redis: RedisService) {
    const opts = {
      connection: bullConnection(),
      prefix: loadEnv().queuePrefix,
    };
    this.queues = {
      detect: new Queue(QUEUES.detect, opts),
      inpaint: new Queue(QUEUES.inpaint, opts),
      webhook: new Queue(QUEUES.webhook, opts),
    };
  }

  async onModuleDestroy() {
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
  }

  async assertDisk() {
    const env = loadEnv();
    await mkdir(env.dataDir, { recursive: true });
    const s = await statfs(env.dataDir);
    const used = 100 * (1 - s.bavail / s.blocks);
    if (used > env.diskLimitPercent) {
      throw new HttpException(
        {
          code: 'disk_full',
          message: `Disco com ${used.toFixed(0)}% de uso (limite ${env.diskLimitPercent}%). Tente depois da limpeza.`,
        },
        HttpStatus.INSUFFICIENT_STORAGE,
      );
    }
  }

  async create(input: CreateJob) {
    if (!input.inputs.length)
      throw new BadRequestException(
        input.type === 'detect'
          ? 'Envie ao menos uma página no campo "pages".'
          : 'Envie ao menos uma imagem no campo "images".',
      );
    for (const i of input.inputs) {
      if (!IMAGE_EXT.test(i.name))
        throw new BadRequestException(
          `"${i.name}" não é uma imagem (png, jpg, webp, gif, bmp).`,
        );
    }
    if (input.callbackUrl) {
      let url: URL;
      try {
        url = new URL(input.callbackUrl);
      } catch {
        throw new BadRequestException('callbackUrl inválida.');
      }
      if (!['http:', 'https:'].includes(url.protocol))
        throw new BadRequestException('callbackUrl precisa ser http ou https.');
    }
    const priority = input.priority === 'high' ? 'high' : 'normal';
    const id = `j_${Date.now().toString(36)}${randomBytes(5).toString('hex')}`;
    const dir = jobDir(id);
    await mkdir(join(dir, 'in'), { recursive: true });
    await mkdir(join(dir, 'out'), { recursive: true });
    const used = new Set<string>();
    const inputs: JobInput[] = [];
    for (const [n, i] of input.inputs.entries()) {
      const name = safeName(i.name, used);
      const file = `${String(n + 1).padStart(5, '0')}${extname(name).toLowerCase()}`;
      await rename(i.path, join(dir, 'in', file));
      let mask: string | undefined;
      if (i.maskPath) {
        mask = `${String(n + 1).padStart(5, '0')}.mask${extname(i.maskPath).toLowerCase() || '.png'}`;
        await rename(i.maskPath, join(dir, 'in', mask));
      }
      inputs.push({ name, file, mask });
    }
    const now = String(Date.now());
    await this.redis.client.hset(key('job', id), {
      id,
      type: input.type,
      status: 'queued',
      client: input.client.id,
      callbackUrl: input.callbackUrl ?? '',
      externalId: input.externalId ?? '',
      priority,
      total: String(inputs.length),
      done: '0',
      createdAt: now,
      inputs: JSON.stringify(inputs),
      params: JSON.stringify(input.params),
      webhook: input.callbackUrl ? 'pending' : 'none',
    });
    await this.queues[input.type].add(
      'job',
      { jobId: id },
      {
        jobId: id,
        priority: PRIORITY[priority],
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    const position =
      (await this.queues[input.type].getWaitingCount()) +
      (await this.queues[input.type].getPrioritizedCount());
    return {
      id,
      type: input.type,
      status: 'queued' as const,
      total: inputs.length,
      position,
    };
  }

  async raw(id: string, client: Client) {
    const row = await this.redis.client.hgetall(key('job', id));
    if (!row.id || row.client !== client.id)
      throw new NotFoundException('Job não encontrado.');
    return row;
  }

  summary(row: Record<string, string>) {
    const env = loadEnv();
    return {
      id: row.id,
      type: row.type as JobType,
      status: row.status as JobStatus,
      externalId: row.externalId || null,
      total: Number(row.total),
      done: Number(row.done ?? 0),
      error: row.error || null,
      createdAt: iso(row.createdAt),
      startedAt: iso(row.startedAt),
      finishedAt: iso(row.finishedAt),
      timings: {
        queuedMs: ms(row.createdAt, row.startedAt),
        gpuMs: row.gpuMs ? Number(row.gpuMs) : null,
        totalMs: ms(row.createdAt, row.finishedAt),
      },
      webhook: row.webhook || 'none',
      resultUrl: `${env.publicUrl}/jobs/${row.id}`,
      expiresAt: row.finishedAt
        ? new Date(
            Number(row.finishedAt) + env.jobTtlSeconds * 1000,
          ).toISOString()
        : null,
    };
  }

  async results(row: Record<string, string>) {
    const inputs = JSON.parse(row.inputs ?? '[]') as JobInput[];
    const stored = await this.redis.client.hgetall(
      key('job', row.id, 'result'),
    );
    const base = `${loadEnv().publicUrl}/jobs/${row.id}/files`;
    return inputs.map((i) => {
      const r = stored[i.name]
        ? (JSON.parse(stored[i.name]) as Record<string, unknown>)
        : null;
      if (!r) return { name: i.name, status: 'pending' };
      return {
        ...r,
        ...(typeof r.file === 'string'
          ? { url: `${base}/${encodeURIComponent(r.file)}` }
          : {}),
      };
    });
  }

  async detail(id: string, client: Client) {
    const row = await this.raw(id, client);
    return {
      ...this.summary(row),
      params: JSON.parse(row.params ?? '{}') as unknown,
      pages: await this.results(row),
    };
  }

  async outputFile(id: string, client: Client, name: string) {
    const row = await this.raw(id, client);
    const stored = await this.redis.client.hgetall(
      key('job', row.id, 'result'),
    );
    const files = Object.values(stored)
      .map((v) => (JSON.parse(v) as { file?: string }).file)
      .filter((f): f is string => !!f);
    if (!files.includes(name))
      throw new NotFoundException('Arquivo não encontrado neste job.');
    const path = join(jobDir(id), 'out', name);
    if (!existsSync(path)) throw new NotFoundException('O arquivo já expirou.');
    return path;
  }

  async outputFiles(id: string, client: Client) {
    const row = await this.raw(id, client);
    const stored = await this.redis.client.hgetall(
      key('job', row.id, 'result'),
    );
    return Object.values(stored)
      .map((v) => (JSON.parse(v) as { file?: string }).file)
      .filter((f): f is string => !!f)
      .map((f) => ({ name: f, path: join(jobDir(id), 'out', f) }))
      .filter((f) => existsSync(f.path));
  }

  async cancel(id: string, client: Client) {
    const row = await this.raw(id, client);
    if (!['queued', 'running'].includes(row.status))
      throw new ConflictException(`O job já terminou (${row.status}).`);
    const job = await this.queues[row.type as JobType].getJob(id);
    const active = job ? await job.isActive() : false;
    if (job && !active) await job.remove().catch(() => undefined);
    await this.finish(id, 'canceled', 'Cancelado pelo cliente.');
    if (!active) await rm(jobDir(id), { recursive: true, force: true });
    return { id, status: 'canceled' as const };
  }

  async finish(id: string, status: JobStatus, error?: string) {
    const ttl = loadEnv().jobTtlSeconds;
    const row = await this.redis.client.hgetall(key('job', id));
    await this.redis.client
      .multi()
      .hset(key('job', id), {
        status,
        finishedAt: String(Date.now()),
        ...(error ? { error } : {}),
      })
      .expire(key('job', id), ttl)
      .expire(key('job', id, 'result'), ttl)
      .exec();
    if (row.callbackUrl)
      await this.queues.webhook.add(
        'deliver',
        { jobId: id, attempt: 1 },
        { removeOnComplete: true, removeOnFail: true },
      );
  }
}
