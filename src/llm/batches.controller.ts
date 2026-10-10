import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { CurrentClient } from '../auth/auth.guard';
import type { Client } from '../auth/clients.service';
import { BatchesService } from './batches.service';

@Controller('batches')
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Post()
  create(
    @CurrentClient() client: Client,
    @Body() body: { requests?: unknown },
  ) {
    return this.batches.create(client, body?.requests);
  }

  @Get(':id')
  retrieve(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.batches.retrieve(id, client);
  }

  @Get(':id/results')
  results(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.batches.results(id, client);
  }

  @Post(':id/cancel')
  cancel(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.batches.cancel(id, client);
  }

  @Delete(':id')
  purge(@CurrentClient() client: Client, @Param('id') id: string) {
    return this.batches.purge(id, client);
  }
}
