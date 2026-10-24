import { createHmac } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../../config/env';
import { safeEqual } from '../../utils/crypto';

export interface SignedUrlOptions {
  fileName: string;
  mimeType: string;
  ttlSeconds: number;
  disposition: 'inline' | 'attachment';
}

/** Private object storage. Objects are never publicly readable; access is via short-lived signed URLs. */
export interface StorageDriver {
  put(key: string, body: Buffer, mimeType: string): Promise<void>;
  signedUrl(key: string, opts: SignedUrlOptions): Promise<string>;
}

function contentDisposition(fileName: string, disposition: string) {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// ---------- Local filesystem driver (development / single server) ----------

interface LocalToken {
  k: string; // storage key
  n: string; // file name
  t: string; // mime type
  d: 'inline' | 'attachment';
  e: number; // expiry, epoch seconds
}

/** Separate key derived from the JWT secret, so file links cannot be forged or reused as tokens. */
const signingKey = () => createHmac('sha256', env.JWT_ACCESS_SECRET).update('erp:file-url:v1').digest();

export function signFileToken(payload: LocalToken): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', signingKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyFileToken(token: string): LocalToken | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', signingKey()).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LocalToken;
    if (typeof payload.e !== 'number' || payload.e < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

class LocalDriver implements StorageDriver {
  private readonly root = path.resolve(env.STORAGE_LOCAL_DIR);

  private resolve(key: string) {
    const full = path.resolve(this.root, key);
    // Keys are server-generated, but never allow a path outside the storage root.
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async put(key: string, body: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, { mode: 0o600 });
  }

  async signedUrl(key: string, opts: SignedUrlOptions) {
    const token = signFileToken({ k: key, n: opts.fileName, t: opts.mimeType, d: opts.disposition, e: Math.floor(Date.now() / 1000) + opts.ttlSeconds });
    return `/api/v1/files/${token}`;
  }

  read(key: string) {
    return readFile(this.resolve(key));
  }
}

// ---------- S3-compatible driver (AWS S3, Cloudflare R2, MinIO) ----------

class S3Driver implements StorageDriver {
  private readonly client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
  });

  async put(key: string, body: Buffer, mimeType: string) {
    await this.client.send(
      new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body, ContentType: mimeType, ServerSideEncryption: env.S3_ENDPOINT ? undefined : 'AES256' }),
    );
  }

  signedUrl(key: string, opts: SignedUrlOptions) {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
        ResponseContentType: opts.mimeType,
        ResponseContentDisposition: contentDisposition(opts.fileName, opts.disposition),
      }),
      { expiresIn: opts.ttlSeconds },
    );
  }
}

export const localDriver = new LocalDriver();
export const storage: StorageDriver = env.STORAGE_DRIVER === 's3' ? new S3Driver() : localDriver;
export { contentDisposition };
