// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the end-to-end
// tests, so the tests run the exact wiring of the container.
// -----------------------------------------------------------------------------

import { ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Discovery: the lock appears once the bridge was read.
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated((device) => app.deviceCreated(device));
  gladys.onDeviceUpdated((device) => app.deviceCreated(device));

  // Commands: lock always; unlock and open only when allowed.
  gladys.onSetValue((device, feature, value) => app.setValue(device, feature, value));

  // Configuration screen buttons.
  gladys.onAction(ACTIONS.TEST, () => app.testConnection());
  gladys.onAction(ACTIONS.ADOPT, () => app.adoptBridge());

  // Configuration changed by the user.
  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated');
    return app.configUpdated(config);
  });

  // Connection lifecycle: the configuration is read (and read again until it
  // comes), then the status, the Discovery and the badges are sent again (the
  // core keeps them in memory only).
  gladys.on('connected', () =>
    app.gladysConnected().catch((err) => logger?.error('Start failed', err)),
  );
}
