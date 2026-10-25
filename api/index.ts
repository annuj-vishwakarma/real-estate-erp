import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../apps/api/src/app';
import { connectDb } from '../apps/api/src/config/db';
import mongoose from 'mongoose';

let appInstance: ReturnType<typeof createApp> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  // Ensure MongoDB is connected
  if (mongoose.connection.readyState !== 1) {
    await connectDb();
  }

  // Initialize Express app if not already initialized
  if (!appInstance) {
    appInstance = createApp();
  }

  // Ensure request URL matches Express routes
  if (req.url && !req.url.startsWith('/api')) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }

  return appInstance(req, res);
}
