import { spawnSync } from 'node:child_process';
import {
  newRequest,
  openReply,
  sealReply,
  sealRequest,
} from '../src/auth/service-key';

const API = process.env.API_URL ?? 'http://127.0.0.1:8100';
const ADMIN = process.env.ADMIN_KEY ?? '';
const SERVICE_KEY = process.env.GPU_SERVICE_KEY ?? '';

const VECTOR = {
  key: 'gsk_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  request: {
    v: 1 as const,
    name: 'vetor',
    nonce: 'AAAAAAAAAAAAAAAAAAAAAA',
    iat: 1790000000000,
  },
  reply: { id: 'cliente-vetor', apiKey: 'gk_vetor' },
  token:
    'v1.AQIDBAUGBwgJCgsM.1hmCWz1flCNJSYaJCZtnnUBnW3IFpKjARi7HJlYPZNxWe3GbJKJiAOSjPUnJ39UnktWDjx8qlW-mdIzPyHP8OI9uwIWJwoeh_GvS.hmG_FZB_YEcEe87HOMJaJw',
  sealed:
    'v1.DQ4PEBESExQVFhcY.rlpJ2t_8v6nDR_U6uhmX2-B_iyQAnzzZ9EMEF-dgLN-xTu6uzJZa_yiT.mIV4lPZOhgG8UGS3F6wikg',
};

const results: [string, boolean][] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push([name, ok]);
  console.log(`${ok ? 'OK ' : 'FALHOU'} ${name}${info ? ` · ${info}` : ''}`);
};
const bytes = (start: number, n: number) =>
  Buffer.from(Array.from({ length: n }, (_, i) => start + i));

async function call(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body) headers['content-type'] = 'application/json';
  const r = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data: any = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

const register = (token?: string) =>
  call('POST', '/clients/register', { body: token ? { token } : {} });

const otherKey = () =>
  `gsk_${Buffer.alloc(32, 7).toString('base64url').slice(0, 43)}`;

async function main() {
  if (!ADMIN || !SERVICE_KEY)
    throw new Error('Defina ADMIN_KEY e GPU_SERVICE_KEY.');

  check(
    'vetor fixo: pedido',
    sealRequest(VECTOR.key, VECTOR.request, bytes(1, 12)) === VECTOR.token,
  );
  check(
    'vetor fixo: resposta',
    sealReply(VECTOR.key, VECTOR.request.nonce, VECTOR.reply, bytes(13, 12)) ===
      VECTOR.sealed,
  );

  const bad = spawnSync(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      "require('./src/config/env').loadEnv()",
    ],
    {
      env: { ...process.env, ADMIN_KEY: ADMIN, GPU_SERVICE_KEY: 'gsk_curta' },
      encoding: 'utf8',
    },
  );
  check(
    'API não sobe com a chave inválida',
    bad.status !== 0 && bad.stderr.includes('GPU_SERVICE_KEY inválida'),
    bad.stderr.split('\n').find((l) => l.includes('GPU_SERVICE_KEY')) ?? '',
  );

  const created: string[] = [];
  try {
    const noToken = await register();
    check(
      'sem token: 401',
      noToken.status === 401 &&
        String(noToken.data.message).includes('exige a GPU_SERVICE_KEY'),
      `${noToken.status} · ${noToken.data.message}`,
    );

    const wrong = await register(
      sealRequest(otherKey(), newRequest('check errada')),
    );
    check(
      'chave errada: 401',
      wrong.status === 401 &&
        String(wrong.data.message).includes('não confere'),
      `${wrong.status} · ${wrong.data.message}`,
    );

    const valid = sealRequest(SERVICE_KEY, newRequest('check alterado'));
    const parts = valid.split('.');
    parts[2] = `${parts[2].slice(0, -2)}${parts[2].endsWith('AA') ? 'BB' : 'AA'}`;
    const tampered = await register(parts.join('.'));
    check(
      'token alterado: 401',
      tampered.status === 401,
      `${tampered.status} · ${tampered.data.message}`,
    );

    const req = newRequest('check registro');
    const token = sealRequest(SERVICE_KEY, req);
    const ok = await register(token);
    const reply = ok.data.sealed
      ? openReply<{ id: string; apiKey: string; webhookSecret: string }>(
          SERVICE_KEY,
          req.nonce,
          ok.data.sealed,
        )
      : null;
    if (reply) created.push(reply.id);
    check(
      'chave certa: cadastra e a resposta abre só com o nonce do pedido',
      ok.status === 201 &&
        !!reply?.apiKey &&
        reply.id === ok.data.id &&
        !ok.data.apiKey &&
        openReply(SERVICE_KEY, 'outro-nonce', ok.data.sealed) === null,
      `${ok.status} · ${JSON.stringify(ok.data).slice(0, 80)}`,
    );
    const usable = await call('GET', '/jobs/nao-existe', {
      key: reply?.apiKey,
    });
    check(
      'a chave recebida vale nos jobs',
      usable.status === 404,
      `${usable.status}`,
    );

    const replay = await register(token);
    check(
      'pedido repetido: 409',
      replay.status === 409,
      `${replay.status} · ${replay.data.message}`,
    );

    const old = await register(
      sealRequest(SERVICE_KEY, {
        ...newRequest('check expirado'),
        iat: Date.now() - 6 * 60_000,
      }),
    );
    check(
      'pedido expirado: 401',
      old.status === 401 && String(old.data.message).includes('expirado'),
      `${old.status} · ${old.data.message}`,
    );

    const again = newRequest('check registro');
    const second = await register(sealRequest(SERVICE_KEY, again));
    const secondReply = second.data.sealed
      ? openReply<{ id: string; apiKey: string }>(
          SERVICE_KEY,
          again.nonce,
          second.data.sealed,
        )
      : null;
    if (secondReply) created.push(secondReply.id);
    const list = await call('GET', '/admin/clients', { key: ADMIN });
    const sameName = (list.data as { name: string }[]).filter(
      (c) => c.name === 'check registro',
    );
    const oldKey = await call('GET', '/jobs/nao-existe', {
      key: reply?.apiKey,
    });
    check(
      'mesmo nome substitui o cliente anterior',
      second.status === 201 && sameName.length === 1 && oldKey.status === 401,
      `${second.status} · ${sameName.length} com o nome · chave antiga ${oldKey.status}`,
    );

    let last = 0;
    for (let i = 0; i < 10; i++) last = (await register()).status;
    check('muitas tentativas erradas: 429', last === 429, `${last}`);
  } finally {
    for (const id of created)
      await call('DELETE', `/admin/clients/${id}`, { key: ADMIN });
  }

  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} ok`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
