import { createApp } from './app';
import { env } from './config/env';
import { seedAdminKey } from './services/apiKeyService';
import { logger } from './utils/logger';

seedAdminKey(env.adminApiKey);

const app = createApp();
app.listen(env.port, () => {
  logger.info(`CBE Verify API listening on http://localhost:${env.port}`);
  logger.info(`Admin key: ${env.adminApiKey}`);
});