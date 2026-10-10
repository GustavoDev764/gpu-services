import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.useBodyParser('json', { limit: '300mb' });
  app.enableShutdownHooks();
  await app.listen(env.port, env.host);
  new Logger('app').log(
    `API ouvindo em http://${env.host}:${env.port} · dados em ${env.dataDir} · redis db ${env.redisDb}`,
  );
}

void bootstrap();
