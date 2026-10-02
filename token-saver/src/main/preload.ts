import { contextBridge, ipcRenderer } from "electron";
import type { OptimizationMode } from "../shared/types";

contextBridge.exposeInMainWorld("tokenSaver", {
  selectFolder: () => ipcRenderer.invoke("select-folder"),
  scanProject: (root: string) => ipcRenderer.invoke("scan-project", root),
  runTask: (root: string, task: string, mode: OptimizationMode) =>
    ipcRenderer.invoke("run-task", { root, task, mode }),
  getHistory: (root: string) => ipcRenderer.invoke("get-history", root),
  onScanProgress: (callback: (progress: { scanned: number; total: number }) => void) => {
    ipcRenderer.on("scan-progress", (_event, progress) => callback(progress));
  },
});
