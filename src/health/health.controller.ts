import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { statfs } from 'node:fs/promises';
import { Public } from '../auth/auth.guard';
import { loadEnv } from '../config/env';
import { JobsService } from '../jobs/jobs.service';
import { llmHealth } from '../llm/llm-health';
import { key, RedisService } from '../redis/redis.service';

const STALE_MS = 20_000;

@Controller('health')
export class HealthController {
  constructor(
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) {}

  @Get()
  @Public()
  async health(@Res({ passthrough: true }) res: Response) {
    const worker = await this.redis.client.hgetall(key('worker'));
    const fresh = !!worker.at && Date.now() - Number(worker.at) < STALE_MS;
    const status = !fresh
      ? 'offline'
      : worker.ready === '1'
        ? 'ready'
        : 'starting';
    const queues: Record<string, unknown> = {};
    for (const name of ['detect', 'inpaint'] as const) {
      const c = await this.jobs.queues[name].getJobCounts(
        'waiting',
        'prioritized',
        'active',
        'delayed',
      );
      queues[name] = {
        waiting: (c.waiting ?? 0) + (c.prioritized ?? 0),
        active: c.active ?? 0,
        delayed: c.delayed ?? 0,
      };
    }
    const s = await statfs(loadEnv().dataDir).catch(() => null);
    if (status !== 'ready') res.status(503);
    const llm = await llmHealth();
    return {
      status,
      llm,
      worker: fresh
        ? {
            device: worker.device,
            gpu: worker.gpu || null,
            vramTotalMb: worker.vramTotalMb ? Number(worker.vramTotalMb) : null,
            vramUsedMb: worker.vramUsedMb ? Number(worker.vramUsedMb) : null,
            temperatureC: worker.temperatureC
              ? Number(worker.temperatureC)
              : null,
            models: worker.models
              ? (JSON.parse(worker.models) as unknown)
              : null,
            error: worker.error || null,
            startedAt: worker.startedAt
              ? new Date(Number(worker.startedAt)).toISOString()
              : null,
          }
        : null,
      queues,
      disk: s
        ? {
            usedPercent: Math.round(1000 * (1 - s.bavail / s.blocks)) / 10,
            freeGb: Math.round((s.bavail * s.bsize) / 1024 ** 3),
          }
        : null,
    };
  }
}
