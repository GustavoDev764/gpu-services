import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { loadEnv } from '../config/env';
import { ClientsService, type Client } from './clients.service';

const PUBLIC = 'gpu:public';
const ADMIN = 'gpu:admin';

export const Public = () => SetMetadata(PUBLIC, true);
export const AdminOnly = () => SetMetadata(ADMIN, true);

type AuthedRequest = Request & { client?: Client };

export const CurrentClient = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): Client => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    return req.client!;
  },
);

function tokenOf(req: Request): string {
  const auth = req.headers.authorization ?? '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-api-key'];
  return (Array.isArray(header) ? header[0] : header)?.trim() ?? '';
}

function same(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly clients: ClientsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token = tokenOf(req);
    if (!token)
      throw new UnauthorizedException(
        'Informe a chave em Authorization: Bearer <chave>.',
      );
    const isAdmin = same(token, loadEnv().adminKey);
    if (this.reflector.getAllAndOverride<boolean>(ADMIN, targets)) {
      if (!isAdmin)
        throw new ForbiddenException('Rota só para a chave de administração.');
      return true;
    }
    if (isAdmin)
      throw new ForbiddenException(
        'Use a chave de um cliente para criar e consultar jobs.',
      );
    const client = await this.clients.byKey(token);
    if (!client) throw new UnauthorizedException('Chave inválida.');
    req.client = client;
    return true;
  }
}
