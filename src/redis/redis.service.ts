import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConnectionOptions } from 'bullmq';
import { Redis, type RedisOptions } from 'ioredis';
import { loadEnv } from '../config/env';

export const QUEUES = {
  detect: 'gpu-detect',
  inpaint: 'gpu-inpaint',
  webhook: 'gpu-webhook',
} as const;

export function redisOptions(): RedisOptions {
  const env = loadEnv();
  const url = new URL(env.redisUrl);
  return {
    host: url.hostname || '127.0.0.1',
    port: Number(url.port || 6379),
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: env.redisDb,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}

export const bullConnection = () =>
  redisOptions() as unknown as ConnectionOptions;

export const key = (...parts: string[]) =>
  [loadEnv().keyPrefix, ...parts].join(':');

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client = new Redis(redisOptions());

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
  }
}
