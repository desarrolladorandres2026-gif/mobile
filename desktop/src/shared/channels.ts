/**
 * Nombres de canal IPC, en un solo sitio para que `preload.ts` y los
 * módulos de `main/` nunca se desincronicen por una cadena mal copiada.
 */
export const CHANNELS = {
  // Renderer → main (invoke, con validación en `shared/bridge.ts`).
  attention: 'zipp:attention',
  reportStatus: 'zipp:report-status',
  settingsGet: 'zipp:settings-get',
  settingsSet: 'zipp:settings-set',
  updatesCheck: 'zipp:updates-check',
  printTicket: 'zipp:print-ticket',
  printersList: 'zipp:printers-list',

  // Main → renderer (send/on).
  closeStoreRequest: 'zipp:close-store-request',
  /** Renderer → main: confirma que ya cerró el negocio (o que lo intentó). */
  closeStoreAck: 'zipp:close-store-ack',
  notificationClick: 'zipp:notification-click',
  updateStatus: 'zipp:update-status',

  // Renderer → main (invoke).
  pendingCrashReportGet: 'zipp:crash-report-get',
  pendingCrashReportClear: 'zipp:crash-report-clear',
} as const;
