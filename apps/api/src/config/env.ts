import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/real_estate_erp?replicaSet=rs0'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  /** Comma-separated list of allowed browser origins. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** Public URL of the web app, used in email links. */
  APP_URL: z.string().url().default('http://localhost:5173'),
  COOKIE_SECURE: bool.optional(),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Real Estate ERP <no-reply@example.com>'),
  JOBS_ENABLED: bool.default(true),
  FOLLOWUP_REMINDER_CRON: z.string().default('*/30 * * * *'),
  /** `local` (dev/single server) or `s3` (any S3-compatible private bucket). */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('.data/uploads'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(15),
  FILE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  RESERVATION_EXPIRY_CRON: z.string().default('*/5 * * * *'),
  INSTALLMENT_REMINDER_CRON: z.string().default('30 3 * * *'), // 09:00 IST
  REMINDER_DAYS_AHEAD: z.coerce.number().int().min(0).max(60).default(7),
  LOGIN_RATE_LIMIT_PER_15_MIN: z.coerce.number().int().min(1).default(10),
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19456),
});

export type Env = z.infer<typeof schema> & { isProd: boolean; isTest: boolean; cookieSecure: boolean; corsOrigins: string[] };

function load(): Env {
  // Treat blank values (e.g. `S3_ENDPOINT=` or `${VAR:-}` in compose) as unset.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ''));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  if (e.STORAGE_DRIVER === 's3' && !e.S3_BUCKET) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  if (isProd && /change-me|dev-only/i.test(e.JWT_ACCESS_SECRET)) {
    throw new Error('Refusing to start in production with a placeholder JWT secret');
  }
  return {
    ...e,
    isProd,
    isTest: e.NODE_ENV === 'test',
    cookieSecure: e.COOKIE_SECURE ?? isProd,
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

export const env = load();
