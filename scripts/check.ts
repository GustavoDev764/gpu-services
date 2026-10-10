import { createHmac, timingSafeEqual } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const API = process.env.API_URL ?? 'http://127.0.0.1:8100';
const ADMIN = process.env.ADMIN_KEY ?? '';
const PAGES_DIR =
  process.env.CHECK_PAGES_DIR ??
  '../manhaw-translate/downloads/space-cheon-ma-3077/chapter-002';
const PAGES = Number(process.env.CHECK_PAGES ?? 3);

const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push([name, ok, info]);
  console.log(`${ok ? 'OK ' : 'FALHOU'} ${name}${info ? ` · ${info}` : ''}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function call(
  method: string,
  path: string,
  opts: { key?: string; body?: unknown; form?: FormData } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body) headers['content-type'] = 'application/json';
  const r = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const buf = Buffer.from(await r.arrayBuffer());
  let data: any = buf;
  if ((r.headers.get('content-type') ?? '').includes('json'))
    data = JSON.parse(buf.toString('utf8'));
  return { status: r.status, data, headers: r.headers };
}

type Hook = {
  body: any;
  headers: IncomingMessage['headers'];
  raw: string;
  at: number;
};

async function receiver(failFirst: Set<string>) {
  const hooks: Hook[] = [];
  const seen = new Map<string, number>();
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: string };
      const n = (seen.get(body.id) ?? 0) + 1;
      seen.set(body.id, n);
      if (failFirst.has(body.id) && n === 1) {
        res.writeHead(500).end();
        return;
      }
      hooks.push({ body, headers: req.headers, raw, at: Date.now() });
      res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    hooks,
    seen,
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`,
  };
}

function validSignature(secret: string, hook: Hook) {
  const ts = String(hook.headers['x-gpu-timestamp']);
  const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${hook.raw}`).digest('hex')}`;
  const got = String(hook.headers['x-gpu-signature']);
  return (
    got.length === expected.length &&
    timingSafeEqual(Buffer.from(got), Buffer.from(expected))
  );
}

async function waitHook(hooks: Hook[], id: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const h = hooks.find((x) => x.body.id === id);
    if (h) return h;
    await sleep(300);
  }
  return null;
}

async function waitStatus(key: string, id: string, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await call('GET', `/jobs/${id}`, { key });
    if (!['queued', 'running'].includes(r.data.status)) return r.data;
    await sleep(500);
  }
  return null;
}

async function main() {
  if (!ADMIN) throw new Error('Defina ADMIN_KEY.');
  const health = await call('GET', '/health');
  check(
    'saúde: worker pronto',
    health.status === 200 && health.data.status === 'ready',
    `${health.status} · ${health.data.status} · ${health.data.worker?.device ?? '-'}`,
  );

  const noKey = await call('GET', '/jobs/x');
  check('sem chave: 401', noKey.status === 401, `${noKey.status}`);
  const adminOnJobs = await call('POST', '/jobs/detect', {
    key: ADMIN,
    form: new FormData(),
  });
  check(
    'chave admin não cria job: 403',
    adminOnJobs.status === 403,
    `${adminOnJobs.status}`,
  );
  const clientOnAdmin = await call('GET', '/admin/settings', {
    key: 'gk_invalida',
  });
  check(
    'chave de cliente não acessa admin: 403',
    clientOnAdmin.status === 403,
    `${clientOnAdmin.status}`,
  );

  const a = await call('POST', '/admin/clients', {
    key: ADMIN,
    body: { name: 'check A' },
  });
  const b = await call('POST', '/admin/clients', {
    key: ADMIN,
    body: { name: 'check B' },
  });
  check(
    'cria clientes',
    a.status === 201 &&
      !!a.data.apiKey &&
      !!a.data.webhookSecret &&
      b.status === 201,
    `${a.status}`,
  );
  const keyA = a.data.apiKey as string;

  const badSetting = await call('PUT', '/admin/settings', {
    key: ADMIN,
    body: { detect_batch: 0 },
  });
  check(
    'configuração inválida: 400',
    badSetting.status === 400,
    `${badSetting.status}`,
  );
  const setting = await call('PUT', '/admin/settings', {
    key: ADMIN,
    body: { detect_batch: 4, detect_concurrency: 1 },
  });
  check(
    'altera configuração',
    setting.status === 200 &&
      setting.data.detect_batch === 4 &&
      setting.data.detect_concurrency === 1,
    JSON.stringify(setting.data).slice(0, 120),
  );

  const failFirst = new Set<string>();
  const rx = await receiver(failFirst);
  try {
    const files = readdirSync(PAGES_DIR)
      .filter((f) => /\.(webp|png|jpe?g)$/i.test(f))
      .sort()
      .slice(0, PAGES);
    const form = new FormData();
    for (const f of files)
      form.append('pages', new Blob([readFileSync(join(PAGES_DIR, f))]), f);
    form.append(
      'pages',
      new Blob([Buffer.from('isto não é uma imagem')]),
      'quebrada.png',
    );
    form.append('callbackUrl', rx.url);
    form.append('externalId', 'item-teste-1');
    const det = await call('POST', '/jobs/detect', { key: keyA, form });
    check(
      'cria job de detecção',
      det.status === 201 &&
        det.data.status === 'queued' &&
        det.data.total === files.length + 1,
      `${det.status} · ${JSON.stringify(det.data).slice(0, 160)}`,
    );
    failFirst.add(det.data.id);

    const otherClient = await call('GET', `/jobs/${det.data.id}`, {
      key: b.data.apiKey,
    });
    check(
      'outro cliente não vê o job: 404',
      otherClient.status === 404,
      `${otherClient.status}`,
    );

    const hook = await waitHook(rx.hooks, det.data.id, 10 * 60_000);
    check(
      'webhook chegou depois de falhar uma vez',
      !!hook && rx.seen.get(det.data.id) === 2,
      `tentativas ${rx.seen.get(det.data.id)}`,
    );
    check(
      'assinatura do webhook válida',
      !!hook && validSignature(a.data.webhookSecret, hook),
      String(hook?.headers['x-gpu-signature'] ?? '').slice(0, 30),
    );
    check(
      'webhook com resumo',
      hook?.body.status === 'succeeded' &&
        hook?.body.externalId === 'item-teste-1' &&
        hook?.body.event === 'job.finished',
      JSON.stringify(hook?.body ?? {}).slice(0, 200),
    );
    const detail = await call('GET', `/jobs/${det.data.id}`, { key: keyA });
    const pages = detail.data.pages as any[];
    const okPages = pages.filter((p) => p.status === 'done');
    check(
      'detecção por página no formato do detect.py',
      okPages.length === files.length &&
        okPages.every(
          (p) => Array.isArray(p.detections) && p.width > 0 && p.height > 0,
        ),
      okPages
        .map((p) => `${p.name}:${p.detections.length} caixas/${p.tiles} blocos`)
        .join(' '),
    );
    check(
      'achou balões',
      okPages.some((p) =>
        p.detections.some(
          (d: any) => d.label === 'bubble' || d.label === 'text_bubble',
        ),
      ),
      '',
    );
    check(
      'arquivo inválido falha só ele',
      pages.some((p) => p.name === 'quebrada.png' && p.status === 'failed'),
      '',
    );
    check(
      'tempos do job',
      detail.data.timings.gpuMs > 0 &&
        detail.data.timings.totalMs > 0 &&
        detail.data.webhook === 'delivered',
      JSON.stringify(detail.data.timings),
    );

    const W = 384;
    const H = 512;
    const image = png(W, H, (x, y) =>
      x > 120 && x < 260 && y > 200 && y < 240
        ? [10, 10, 10]
        : [200 + ((x * 7) % 40), 180 + ((y * 3) % 50), 150],
    );
    const mask = png(W, H, (x, y) =>
      x > 110 && x < 270 && y > 190 && y < 250 ? [255, 255, 255] : [0, 0, 0],
    );
    const inForm = new FormData();
    inForm.append('images', new Blob([image]), 'janela-1.png');
    inForm.append('masks', new Blob([mask]), 'janela-1-mask.png');
    inForm.append('images', new Blob([image]), 'janela-2.png');
    inForm.append('masks', new Blob([mask]), 'janela-2-mask.png');
    inForm.append('callbackUrl', rx.url);
    inForm.append('priority', 'high');
    const inp = await call('POST', '/jobs/inpaint', {
      key: keyA,
      form: inForm,
    });
    check(
      'cria job de inpaint',
      inp.status === 201,
      `${inp.status} · ${JSON.stringify(inp.data).slice(0, 160)}`,
    );
    const inHook = await waitHook(rx.hooks, inp.data.id, 5 * 60_000);
    check(
      'inpaint terminou',
      inHook?.body.status === 'succeeded' && inHook?.body.files === 2,
      JSON.stringify(inHook?.body ?? {}).slice(0, 160),
    );
    const inDetail = await call('GET', `/jobs/${inp.data.id}`, { key: keyA });
    const first = inDetail.data.pages[0];
    check(
      'resultado do inpaint com arquivo e janelas',
      first?.file === 'janela-1.png' &&
        first?.width === W &&
        first?.height === H &&
        first?.windows === 1,
      JSON.stringify(first ?? {}).slice(0, 200),
    );
    const file = await call('GET', `/jobs/${inp.data.id}/files/${first.file}`, {
      key: keyA,
    });
    const isPng =
      Buffer.isBuffer(file.data) &&
      file.data.subarray(1, 4).toString('ascii') === 'PNG';
    check(
      'baixa a imagem gerada',
      file.status === 200 &&
        isPng &&
        file.data.readUInt32BE(16) === W &&
        file.data.readUInt32BE(20) === H,
      `${file.status} · ${file.data.length} bytes`,
    );
    const zip = await call('GET', `/jobs/${inp.data.id}/files.zip`, {
      key: keyA,
    });
    check(
      'baixa todas em .zip',
      zip.status === 200 &&
        Buffer.isBuffer(zip.data) &&
        zip.data.subarray(0, 2).toString('ascii') === 'PK',
      `${zip.status} · ${zip.data.length} bytes`,
    );
    const otherFile = await call(
      'GET',
      `/jobs/${inp.data.id}/files/${first.file}`,
      { key: b.data.apiKey },
    );
    check(
      'outro cliente não baixa: 404',
      otherFile.status === 404,
      `${otherFile.status}`,
    );

    const bigForm = new FormData();
    for (let i = 0; i < 3; i++)
      for (const f of files)
        bigForm.append(
          'pages',
          new Blob([readFileSync(join(PAGES_DIR, f))]),
          `${i}-${f}`,
        );
    const blocker = await call('POST', '/jobs/detect', {
      key: keyA,
      form: bigForm,
    });
    const toCancel = await call('POST', '/jobs/detect', {
      key: keyA,
      form: (() => {
        const f = new FormData();
        f.append(
          'pages',
          new Blob([readFileSync(join(PAGES_DIR, files[0]))]),
          files[0],
        );
        f.append('callbackUrl', rx.url);
        return f;
      })(),
    });
    const canceled = await call('DELETE', `/jobs/${toCancel.data.id}`, {
      key: keyA,
    });
    check(
      'cancela job na fila',
      canceled.status === 200 && canceled.data.status === 'canceled',
      `${canceled.status} · ${JSON.stringify(canceled.data)}`,
    );
    const cancelHook = await waitHook(rx.hooks, toCancel.data.id, 30_000);
    check(
      'webhook de cancelado',
      cancelHook?.body.status === 'canceled',
      JSON.stringify(cancelHook?.body ?? {}).slice(0, 120),
    );
    const blockerDone = await waitStatus(keyA, blocker.data.id, 10 * 60_000);
    check(
      'fila segue depois do cancelamento',
      blockerDone?.status === 'succeeded',
      blockerDone?.status ?? 'timeout',
    );
    const again = await call('DELETE', `/jobs/${blocker.data.id}`, {
      key: keyA,
    });
    check(
      'não cancela job terminado: 409',
      again.status === 409,
      `${again.status}`,
    );
  } finally {
    rx.server.close();
    await call('PUT', '/admin/settings', {
      key: ADMIN,
      body: { detect_batch: 16, detect_concurrency: 2 },
    });
    await call('DELETE', `/admin/clients/${a.data.id}`, { key: ADMIN });
    await call('DELETE', `/admin/clients/${b.data.id}`, { key: ADMIN });
  }
  const failed = results.filter((r) => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} ok`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
