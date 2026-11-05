// -----------------------------------------------------------------------------
// Entry point of the `loqed-webhook` sub-container (manifest `containers`,
// same image, command `node src/receiver.js`): the HTTP endpoint the bridge
// posts its events to. No Gladys credentials and no key of the bridge here:
// see src/push/service.js.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { startWebhookService } from './push/service.js';

const logger = createLogger({ name: 'loqed-webhook' });

try {
  const service = await startWebhookService({ env: process.env, logger });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info(`${signal}: stopping`);
      service.stop().finally(() => process.exit(0));
    });
  }
} catch (err) {
  logger.error('The webhook receiver could not start', err);
  process.exit(1);
}
