import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Ip,
  Post,
  UnauthorizedException,
} from '@nestjs/common';
import { loadEnv } from '../config/env';
import { key, RedisService } from '../redis/redis.service';
import { Public } from './auth.guard';
import { ClientsService } from './clients.service';
import { openRequest, REQUEST_MAX_AGE_MS, sealReply } from './service-key';

const FAIL_LIMIT = 10;
const FAIL_WINDOW_SECONDS = 60;
const NONCE_TTL_SECONDS = 600;

@Controller('clients')
export class RegisterController {
  constructor(
    private readonly clients: ClientsService,
    private readonly redis: RedisService,
  ) {}

  private async fail(ip: string, message: string): Promise<never> {
    const failKey = key('register-fail', ip);
    const n = await this.redis.client.incr(failKey);
    if (n === 1) await this.redis.client.expire(failKey, FAIL_WINDOW_SECONDS);
    throw new UnauthorizedException(message);
  }

  @Post('register')
  @Public()
  async register(@Body() body: { token?: unknown }, @Ip() ip: string) {
    const env = loadEnv();
    const fails = Number(await this.redis.client.get(key('register-fail', ip)));
    if (fails >= FAIL_LIMIT) {
      throw new HttpException(
        'Muitas tentativas com a chave errada. Tente de novo em 1 minuto.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const token = typeof body?.token === 'string' ? body.token : '';
    if (!token) {
      return this.fail(
        ip,
        'Este serviço de GPU exige a GPU_SERVICE_KEY. Informe a chave na configuração deste sistema.',
      );
    }
    const req = openRequest(env.serviceKey, token);
    if (
      !req ||
      req.v !== 1 ||
      typeof req.nonce !== 'string' ||
      typeof req.iat !== 'number'
    ) {
      return this.fail(
        ip,
        'A GPU_SERVICE_KEY informada não confere com a do serviço de GPU.',
      );
    }
    if (Math.abs(Date.now() - req.iat) > REQUEST_MAX_AGE_MS) {
      throw new UnauthorizedException(
        'Pedido expirado. Confira o relógio deste computador.',
      );
    }
    const fresh = await this.redis.client.set(
      key('register-nonce', req.nonce),
      '1',
      'EX',
      NONCE_TTL_SECONDS,
      'NX',
    );
    if (fresh !== 'OK') {
      throw new ConflictException('Pedido repetido. Tente conectar de novo.');
    }
    const name = String(req.name ?? '')
      .trim()
      .slice(0, 80);
    if (!name) throw new BadRequestException('Informe o nome do cliente.');
    for (const id of await this.clients.idsByName(name)) {
      await this.clients.remove(id);
    }
    if ((await this.clients.list()).length >= env.maxClients) {
      throw new ForbiddenException(
        `Limite de ${env.maxClients} clientes atingido. Remova um em /admin/clients.`,
      );
    }
    const created = await this.clients.create(name);
    return {
      id: created.id,
      sealed: sealReply(env.serviceKey, req.nonce, created),
    };
  }
}
