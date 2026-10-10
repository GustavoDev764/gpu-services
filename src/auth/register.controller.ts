import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Post,
} from '@nestjs/common';
import { loadEnv } from '../config/env';
import { Public } from './auth.guard';
import { ClientsService } from './clients.service';

@Controller('clients')
export class RegisterController {
  constructor(private readonly clients: ClientsService) {}

  @Post('register')
  @Public()
  async register(@Body() body: { name?: string }) {
    const env = loadEnv();
    if (!env.openRegistration) {
      throw new ForbiddenException(
        'Registro automático desligado neste servidor. Peça uma chave ao administrador.',
      );
    }
    const name = String(body?.name ?? '')
      .trim()
      .slice(0, 80);
    if (!name) throw new BadRequestException('Informe o nome do cliente.');
    if ((await this.clients.list()).length >= env.maxClients) {
      throw new ForbiddenException(
        `Limite de ${env.maxClients} clientes atingido. Remova um em /admin/clients.`,
      );
    }
    return this.clients.create(name);
  }
}
