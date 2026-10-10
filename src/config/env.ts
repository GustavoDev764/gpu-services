import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Env {
  port: number;
  host: string;
  redisUrl: string;
  redisDb: number;
  keyPrefix: string;
  queuePrefix: string;
  dataDir: string;
  adminKey: string;
  jobTtlSeconds: number;
  maxUploadMb: number;
  maxFiles: number;
  diskLimitPercent: number;
  webhookDelaysMs: number[];
  webhookTimeoutMs: number;
  publicUrl: string;
  cleanupEveryMs: number;
}

let cached: Env | null = null;

function loadDotEnv() {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}

const num = (v: string | undefined, d: number) =>
  v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d;

export function loadEnv(): Env {
  if (cached) return cached;
  loadDotEnv();
  const e = process.env;
  const adminKey = e.ADMIN_KEY ?? '';
  if (adminKey.length < 16)
    throw new Error('ADMIN_KEY precisa ter ao menos 16 caracteres.');
  const port = num(e.API_PORT, 8000);
  cached = {
    port,
    host: e.API_HOST ?? '0.0.0.0',
    redisUrl: e.REDIS_URL ?? 'redis://127.0.0.1:6379',
    redisDb: num(e.REDIS_DB, 0),
    keyPrefix: e.KEY_PREFIX ?? 'gpu',
    queuePrefix: e.QUEUE_PREFIX ?? 'bull',
    dataDir: resolve(e.DATA_DIR ?? './data'),
    adminKey,
    jobTtlSeconds: num(e.JOB_TTL_SECONDS, 172_800),
    maxUploadMb: num(e.MAX_UPLOAD_MB, 40),
    maxFiles: num(e.MAX_FILES, 2000),
    diskLimitPercent: num(e.DISK_LIMIT_PERCENT, 80),
    webhookDelaysMs: (
      e.WEBHOOK_DELAYS_MS ?? '10000,30000,120000,600000,1800000,7200000'
    )
      .split(',')
      .map((v) => Number(v.trim()))
      .filter((v) => Number.isFinite(v) && v >= 0),
    webhookTimeoutMs: num(e.WEBHOOK_TIMEOUT_MS, 10_000),
    publicUrl: (e.PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, ''),
    cleanupEveryMs: num(e.CLEANUP_EVERY_MS, 600_000),
  };
  return cached;
}
