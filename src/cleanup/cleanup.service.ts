import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnv } from '../config/env';
import { key, RedisService } from '../redis/redis.service';

const TMP_MAX_AGE_MS = 3_600_000;

@Injectable()
export class CleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('cleanup');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(private readonly redis: RedisService) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.run(), loadEnv().cleanupEveryMs);
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async run(): Promise<{ jobs: number; tmp: number }> {
    if (this.busy) return { jobs: 0, tmp: 0 };
    this.busy = true;
    try {
      const env = loadEnv();
      let jobs = 0;
      let tmp = 0;
      const jobsDir = join(env.dataDir, 'jobs');
      for (const id of await readdir(jobsDir).catch(() => [] as string[])) {
        if (await this.redis.client.exists(key('job', id))) continue;
        await rm(join(jobsDir, id), { recursive: true, force: true });
        jobs++;
      }
      const tmpDir = join(env.dataDir, 'tmp');
      for (const f of await readdir(tmpDir).catch(() => [] as string[])) {
        const s = await stat(join(tmpDir, f)).catch(() => null);
        if (s && Date.now() - s.mtimeMs > TMP_MAX_AGE_MS) {
          await rm(join(tmpDir, f), { force: true });
          tmp++;
        }
      }
      if (jobs || tmp)
        this.log.log(
          `limpeza: ${jobs} jobs vencidos, ${tmp} envios incompletos`,
        );
      return { jobs, tmp };
    } catch (err) {
      this.log.error(
        `limpeza: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { jobs: 0, tmp: 0 };
    } finally {
      this.busy = false;
    }
  }
}
