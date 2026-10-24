import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { key, RedisService } from '../redis/redis.service';

export interface Client {
  id: string;
  name: string;
  secret: string;
  createdAt: string;
}

const sha = (value: string) => createHash('sha256').update(value).digest('hex');

@Injectable()
export class ClientsService {
  constructor(private readonly redis: RedisService) {}

  async create(name: string) {
    const id = randomUUID();
    const apiKey = `gk_${randomBytes(24).toString('base64url')}`;
    const secret = `whsec_${randomBytes(24).toString('base64url')}`;
    const createdAt = new Date().toISOString();
    const hash = sha(apiKey);
    await this.redis.client
      .multi()
      .hset(key('client', hash), { id, name, secret, createdAt })
      .hset(key('clients'), id, hash)
      .exec();
    return { id, name, apiKey, webhookSecret: secret, createdAt };
  }

  async byKey(apiKey: string): Promise<Client | null> {
    const row = await this.redis.client.hgetall(key('client', sha(apiKey)));
    return row.id
      ? {
          id: row.id,
          name: row.name,
          secret: row.secret,
          createdAt: row.createdAt,
        }
      : null;
  }

  async byId(id: string): Promise<Client | null> {
    const hash = await this.redis.client.hget(key('clients'), id);
    if (!hash) return null;
    const row = await this.redis.client.hgetall(key('client', hash));
    return row.id
      ? {
          id: row.id,
          name: row.name,
          secret: row.secret,
          createdAt: row.createdAt,
        }
      : null;
  }

  async list() {
    const all = await this.redis.client.hgetall(key('clients'));
    const rows = await Promise.all(
      Object.values(all).map((hash) =>
        this.redis.client.hgetall(key('client', hash)),
      ),
    );
    return rows
      .filter((r) => r.id)
      .map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt }));
  }

  async idsByName(name: string) {
    return (await this.list()).filter((c) => c.name === name).map((c) => c.id);
  }

  async remove(id: string) {
    const hash = await this.redis.client.hget(key('clients'), id);
    if (!hash) throw new NotFoundException('Cliente não encontrado.');
    await this.redis.client
      .multi()
      .del(key('client', hash))
      .hdel(key('clients'), id)
      .exec();
    return { ok: true };
  }
}
