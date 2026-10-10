import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  await app.listen(env.port, env.host);
  new Logger('app').log(
    `API ouvindo em http://${env.host}:${env.port} · dados em ${env.dataDir} · redis db ${env.redisDb}`,
  );
}

void bootstrap();
