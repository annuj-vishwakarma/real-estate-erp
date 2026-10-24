import { tmpdir } from 'node:os';
import { afterAll, beforeAll, inject } from 'vitest';

// Environment must be set before any app module (and `config/env`) is imported.
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = 'test-secret-that-is-long-enough-1234567890';
process.env.JOBS_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = `${tmpdir()}/erp-test-uploads-${process.pid}`;
process.env.MAX_UPLOAD_MB = '1';

let mongoose: typeof import('mongoose').default;

beforeAll(async () => {
  mongoose = (await import('mongoose')).default;
  await import('../src/models');
  const base = inject('mongoUri');
  const dbName = `erp_test_${Math.random().toString(36).slice(2, 10)}`;
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  await mongoose.connect(url.toString());
  // Build indexes up front: uniqueness guarantees are part of what we test.
  await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes()));
});

afterAll(async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});
