import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { AdminOnly } from '../auth/auth.guard';
import { ClientsService } from '../auth/clients.service';
import { SettingsService } from '../settings/settings.service';

@Controller('admin')
@AdminOnly()
export class AdminController {
  constructor(
    private readonly settings: SettingsService,
    private readonly clients: ClientsService,
  ) {}

  @Get('settings')
  getSettings() {
    return this.settings.get();
  }

  @Put('settings')
  setSettings(@Body() body: Record<string, unknown>) {
    return this.settings.set(body);
  }

  @Get('clients')
  listClients() {
    return this.clients.list();
  }

  @Post('clients')
  createClient(@Body() body: { name?: string }) {
    const name = String(body?.name ?? '').trim();
    if (!name) throw new BadRequestException('Informe o nome do cliente.');
    return this.clients.create(name);
  }

  @Delete('clients/:id')
  removeClient(@Param('id') id: string) {
    return this.clients.remove(id);
  }
}
