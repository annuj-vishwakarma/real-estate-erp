import type { IncomingMessage, ServerResponse } from 'node:http';

// Provide defaults so the app does not crash if Vercel environment variables were not yet saved in settings
if (!process.env.MONGODB_URI || process.env.MONGODB_URI.includes('127.0.0.1')) {
  process.env.MONGODB_URI = 'mongodb+srv://anuj123:Anuj%40123@cluster0.6mple3q.mongodb.net/real_estate_erp?retryWrites=true&w=majority';
}
if (!process.env.JWT_ACCESS_SECRET || /change-me|dev-only/i.test(process.env.JWT_ACCESS_SECRET)) {
  process.env.JWT_ACCESS_SECRET = 'pmBCZ7lwxi88X_Ffne4CY4UIq09hUS16FDmaxyMI8HpSUI6F_6SVEBQtqfv0o1TB';
}

let appInstance: any = null;
let connectDbFn: any = null;
let mongooseInstance: any = null;

async function init() {
  if (!appInstance) {
    const { createApp } = await import('../apps/api/src/app');
    const { connectDb } = await import('../apps/api/src/config/db');
    const mongoose = (await import('mongoose')).default;
    appInstance = createApp();
    connectDbFn = connectDb;
    mongooseInstance = mongoose;
  }
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await init();

    // Ensure MongoDB connection is active
    if (mongooseInstance && mongooseInstance.connection.readyState !== 1) {
      await connectDbFn();
    }

    // Fix path routing for Express router
    if (req.url && !req.url.startsWith('/api')) {
      req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
    }

    return appInstance(req, res);
  } catch (err: any) {
    console.error('Serverless API Error:', err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        error: {
          code: 'SERVERLESS_INIT_ERROR',
          message: err?.message || String(err),
          stack: process.env.NODE_ENV !== 'production' ? err?.stack : undefined,
        },
      }),
    );
  }
}
