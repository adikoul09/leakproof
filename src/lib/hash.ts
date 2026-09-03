import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const sha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');

export const hmacSha256Hex = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

/** Constant-time compare of two hex digests. Never use `===` on a signature. */
export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** "+919876504821" → "+91••4821". PII never lands in the database raw. */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return '••••';
  const cc = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)}` : '';
  return `${cc}••${digits.slice(-4)}`;
}

/** "meera.nair@example.com" → "m••••r@example.com". */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '••••';
  const head = local.slice(0, 1);
  const tail = local.length > 1 ? local.slice(-1) : '';
  return `${head}••••${tail}@${domain}`;
}
