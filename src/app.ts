import express from 'express';
import cors from 'cors';
import path from 'node:path';
import verifyRoutes from './routes/verify';
import apiKeyRoutes from './routes/apiKeys';
import healthRoutes from './routes/health';
import { errorHandler } from './middleware/errorHandler';

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(process.cwd(), 'public')));

  app.use(healthRoutes);
  app.use('/api', verifyRoutes);
  app.use('/api', apiKeyRoutes);

  app.use((req, res) => {
    if (req.path.startsWith('/api')) {
      return res.status(404).json({ success: false, message: 'Not found' });
    }
    return res.sendFile(path.join(process.cwd(), 'public', 'index.html'));
  });

  app.use(errorHandler);
  return app;
}