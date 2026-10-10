import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { key, RedisService } from '../redis/redis.service';

type Spec = {
  default: number | boolean;
  min?: number;
  max?: number;
  integer?: boolean;
};

export const SETTINGS: Record<string, Spec> = {
  detect_batch: { default: 8, min: 1, max: 64, integer: true },
  detect_concurrency: { default: 2, min: 1, max: 8, integer: true },
  detect_threshold: { default: 0.4, min: 0.05, max: 0.99 },
  tile_aspect: { default: 1.6, min: 0.5, max: 4 },
  tile_overlap: { default: 0.25, min: 0, max: 0.6 },
  fp16_detect: { default: true },
  inpaint_batch: { default: 16, min: 1, max: 128, integer: true },
  inpaint_batch_pixels: {
    default: 16_000_000,
    min: 262_144,
    max: 200_000_000,
    integer: true,
  },
  inpaint_concurrency: { default: 2, min: 1, max: 8, integer: true },
  lama_context: { default: 200, min: 0, max: 1000, integer: true },
  fp16_lama: { default: false },
};

export type Settings = Record<keyof typeof SETTINGS, number | boolean>;

function parse(name: string, raw: unknown): number | boolean {
  const spec = SETTINGS[name];
  if (typeof spec.default === 'boolean') {
    if (raw === true || raw === 'true' || raw === '1' || raw === 1) return true;
    if (raw === false || raw === 'false' || raw === '0' || raw === 0)
      return false;
    throw new BadRequestException(`${name}: use true ou false.`);
  }
  const n = Number(raw);
  if (
    !Number.isFinite(n) ||
    (spec.integer && !Number.isInteger(n)) ||
    n < spec.min! ||
    n > spec.max!
  ) {
    throw new BadRequestException(
      `${name}: de ${spec.min} a ${spec.max}${spec.integer ? ' (inteiro)' : ''}.`,
    );
  }
  return n;
}

@Injectable()
export class SettingsService implements OnModuleInit {
  constructor(private readonly redis: RedisService) {}

  async onModuleInit() {
    const multi = this.redis.client.multi();
    for (const [name, spec] of Object.entries(SETTINGS))
      multi.hsetnx(key('settings'), name, String(spec.default));
    await multi.exec();
  }

  async get(): Promise<Settings> {
    const row = await this.redis.client.hgetall(key('settings'));
    const out: Record<string, number | boolean> = {};
    for (const [name, spec] of Object.entries(SETTINGS)) {
      try {
        out[name] =
          row[name] === undefined ? spec.default : parse(name, row[name]);
      } catch {
        out[name] = spec.default;
      }
    }
    return out;
  }

  async set(input: Record<string, unknown>): Promise<Settings> {
    const changes: Record<string, string> = {};
    for (const [name, raw] of Object.entries(input ?? {})) {
      if (!(name in SETTINGS))
        throw new BadRequestException(`Configuração desconhecida: ${name}.`);
      changes[name] = String(parse(name, raw));
    }
    if (!Object.keys(changes).length)
      throw new BadRequestException('Nada para alterar.');
    await this.redis.client.hset(key('settings'), changes);
    await this.redis.client.publish(
      key('settings', 'changed'),
      JSON.stringify(Object.keys(changes)),
    );
    return this.get();
  }
}
