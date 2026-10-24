import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

export const SERVICE_KEY_FORMAT = /^gsk_[A-Za-z0-9_-]{43}$/;
export const REQUEST_MAX_AGE_MS = 5 * 60_000;

const REQUEST_INFO = 'gpu-register-v1';
const REPLY_INFO = 'gpu-register-reply-v1';
const REQUEST_AAD = 'gpu-register';

export interface RegisterRequest {
  v: 1;
  name: string;
  nonce: string;
  iat: number;
}

function derive(serviceKey: string, info: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(serviceKey, 'utf8'),
      Buffer.alloc(0),
      info,
      32,
    ),
  );
}

function seal(key: Buffer, aad: string, data: unknown, iv: Buffer): string {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf8'),
    cipher.final(),
  ]);
  return ['v1', iv, body, cipher.getAuthTag()]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

function open<T>(key: Buffer, aad: string, token: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [iv, body, tag] = parts
    .slice(1)
    .map((p) => Buffer.from(p, 'base64url'));
  if (iv.length !== 12 || tag.length !== 16) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    const text = Buffer.concat([
      decipher.update(body),
      decipher.final(),
    ]).toString('utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function newRequest(name: string): RegisterRequest {
  return {
    v: 1,
    name,
    nonce: randomBytes(16).toString('base64url'),
    iat: Date.now(),
  };
}

export const sealRequest = (
  serviceKey: string,
  request: RegisterRequest,
  iv = randomBytes(12),
) => seal(derive(serviceKey, REQUEST_INFO), REQUEST_AAD, request, iv);

export const openRequest = (serviceKey: string, token: string) =>
  open<RegisterRequest>(derive(serviceKey, REQUEST_INFO), REQUEST_AAD, token);

export const sealReply = (
  serviceKey: string,
  nonce: string,
  data: unknown,
  iv = randomBytes(12),
) => seal(derive(serviceKey, REPLY_INFO), nonce, data, iv);

export const openReply = <T>(
  serviceKey: string,
  nonce: string,
  token: string,
) => open<T>(derive(serviceKey, REPLY_INFO), nonce, token);
