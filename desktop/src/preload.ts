import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS } from './shared/channels';
import type { AttentionPayload, ReportStatusPayload, SettingKey } from './shared/bridge';

/**
 * La única puerta entre el panel (sandboxeado, `contextIsolation: true`) y
 * el proceso principal. El panel detecta esta API por su sola presencia —
 * `if (window.zippDesktop)`—, nunca por el user agent: así la misma build
 * del panel sirve igual en el navegador y en el contenedor.
 *
 * Todo lo que entra aquí se vuelve a validar en `main/ipc.ts`: este archivo
 * no es la barrera de seguridad, solo el cableado.
 */
contextBridge.exposeInMainWorld('zippDesktop', {
  attention: (payload: AttentionPayload) => ipcRenderer.invoke(CHANNELS.attention, payload),
  reportStatus: (payload: ReportStatusPayload) => ipcRenderer.invoke(CHANNELS.reportStatus, payload),
  settings: {
    get: (key: SettingKey) => ipcRenderer.invoke(CHANNELS.settingsGet, { key }),
    set: (key: SettingKey, value: string | number | boolean) => ipcRenderer.invoke(CHANNELS.settingsSet, { key, value }),
  },
  updates: {
    checkNow: () => ipcRenderer.invoke(CHANNELS.updatesCheck),
    onStatus: (callback: (status: { status: string; detail?: unknown }) => void) => {
      const handler = (_event: unknown, payload: { status: string; detail?: unknown }) => callback(payload);
      ipcRenderer.on(CHANNELS.updateStatus, handler);
      return () => ipcRenderer.removeListener(CHANNELS.updateStatus, handler);
    },
  },
  printTicket: (ticket: unknown) => ipcRenderer.invoke(CHANNELS.printTicket, ticket),
  listPrinters: () => ipcRenderer.invoke(CHANNELS.printersList),
  crashReport: {
    get: () => ipcRenderer.invoke(CHANNELS.pendingCrashReportGet),
    clear: () => ipcRenderer.invoke(CHANNELS.pendingCrashReportClear),
  },
  onNotificationClick: (callback: (orderNumber: string) => void) => {
    const handler = (_event: unknown, orderNumber: string) => callback(orderNumber);
    ipcRenderer.on(CHANNELS.notificationClick, handler);
    return () => ipcRenderer.removeListener(CHANNELS.notificationClick, handler);
  },
  /** El contenedor pide cerrar el negocio antes de salir; el panel confirma cuando termine (o lo intente). */
  onCloseStoreRequest: (callback: () => Promise<void> | void) => {
    const handler = async () => {
      try {
        await callback();
      } finally {
        ipcRenderer.send(CHANNELS.closeStoreAck);
      }
    };
    ipcRenderer.on(CHANNELS.closeStoreRequest, handler);
    return () => ipcRenderer.removeListener(CHANNELS.closeStoreRequest, handler);
  },
});
