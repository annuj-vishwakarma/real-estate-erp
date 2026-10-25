import type { IncomingMessage, ServerResponse } from 'node:http';
import mongoose from 'mongoose';
import { createApp } from '../apps/api/src/app';
import { connectDb } from '../apps/api/src/config/db';

let appInstance: ReturnType<typeof createApp> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    // Ensure MongoDB connection is active
    if (mongoose.connection.readyState !== 1) {
      await connectDb();
    }

    // Initialize Express app
    if (!appInstance) {
      appInstance = createApp();
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
          code: 'SERVERLESS_ERROR',
          message: err?.message || String(err),
        },
      }),
    );
  }
}
