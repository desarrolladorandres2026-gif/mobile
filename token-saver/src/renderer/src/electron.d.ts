import type { FileMap, OptimizationMode, OptimizationResult, TaskHistoryEntry } from "../../shared/types";

interface TokenSaverApi {
  selectFolder(): Promise<string | null>;
  scanProject(root: string): Promise<{
    fileMap: FileMap;
    changedSincePrevious: string[];
    history: TaskHistoryEntry[];
  }>;
  runTask(root: string, task: string, mode: OptimizationMode): Promise<OptimizationResult>;
  getHistory(root: string): Promise<TaskHistoryEntry[]>;
  onScanProgress(callback: (progress: { scanned: number; total: number }) => void): void;
}

declare global {
  interface Window {
    tokenSaver: TokenSaverApi;
  }
}

export {};
