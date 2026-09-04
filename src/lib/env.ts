/**
 * Server-side environment. Import from server code only.
 *
 * Deliberately lazy: `env` is a proxy so that importing this module in a
 * context where a var is missing does not crash the whole route — only the
 * code path that actually needs the var does. Keeps the webhook route
 * bootable before RAZORPAY_WEBHOOK_SECRET exists.
 */
import 'server-only';

const bool = (v: string | undefined, dflt = false) =>
  v === undefined || v === '' ? dflt : v === 'true' || v === '1';

export const flags = {
  bandit: bool(process.env.FEATURE_BANDIT),
  voice: bool(process.env.FEATURE_VOICE),
  subscriptions: bool(process.env.FEATURE_SUBSCRIPTIONS, true),
  invoices: bool(process.env.FEATURE_INVOICES),
} as const;

export const optional = {
  razorpayWebhookSecret: () => process.env.RAZORPAY_WEBHOOK_SECRET || null,
  upstashUrl: () => process.env.UPSTASH_REDIS_REST_URL || null,
  resendApiKey: () => process.env.RESEND_API_KEY || null,
  armSalt: () => process.env.ARM_ASSIGNMENT_SALT || null,
} as const;

export function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const env = {
  get databaseUrl() {
    return process.env.DATABASE_URL_POOLED || required('DATABASE_URL');
  },
  get razorpayKeyId() {
    return required('RAZORPAY_KEY_ID');
  },
  get razorpayKeySecret() {
    return required('RAZORPAY_KEY_SECRET');
  },
  get armSalt() {
    return required('ARM_ASSIGNMENT_SALT');
  },
  get geminiApiKey() {
    return required('GEMINI_API_KEY');
  },
  get geminiModel() {
    return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  },
  get appUrl() {
    return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  },
} as const;
