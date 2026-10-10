import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AuthGuard } from './auth/auth.guard';
import { ClientsService } from './auth/clients.service';
import { RegisterController } from './auth/register.controller';
import { BatchesController } from './llm/batches.controller';
import { BatchesService } from './llm/batches.service';
import { CleanupService } from './cleanup/cleanup.service';
import { HealthController } from './health/health.controller';
import { JobsController } from './jobs/jobs.controller';
import { JobsService } from './jobs/jobs.service';
import { RedisService } from './redis/redis.service';
import { SettingsService } from './settings/settings.service';
import { WebhookService } from './webhook/webhook.service';

@Module({
  controllers: [
    JobsController,
    AdminController,
    HealthController,
    RegisterController,
    BatchesController,
  ],
  providers: [
    RedisService,
    ClientsService,
    SettingsService,
    JobsService,
    WebhookService,
    BatchesService,
    CleanupService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}
