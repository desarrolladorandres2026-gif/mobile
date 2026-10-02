export type OptimizationMode = "normal" | "inteligente" | "agresivo" | "completo";

export interface FileEntry {
  path: string;
  size: number;
  mtimeMs: number;
  hash: string;
  tokensEstimate: number;
}

export interface FileMap {
  root: string;
  generatedAt: number;
  hasGit: boolean;
  files: FileEntry[];
}

export interface ScanProgress {
  scanned: number;
  total: number;
}

export interface ContextFileResult {
  path: string;
  included: boolean;
  reason: string;
  tokensEstimate: number;
}

export interface OptimizationResult {
  task: string;
  mode: OptimizationMode;
  files: ContextFileResult[];
  previousWork: PreviousWorkMatch[];
  recentlyChanged: string[];
  tokensWithoutOptimization: number;
  tokensSelected: number;
  tokensSaved: number;
  savingsPercent: number;
  prompt: string;
  createdAt: number;
}

export interface PreviousWorkMatch {
  summary: string;
  date: string;
  filesCovered: string[];
}

export interface TaskHistoryEntry {
  id: string;
  task: string;
  mode: OptimizationMode;
  tokensSelected: number;
  tokensSaved: number;
  savingsPercent: number;
  createdAt: number;
  filesIncluded: string[];
  summaryForFutureReuse?: string;
}

export interface ProjectMemory {
  root: string;
  lastFileMapAt: number;
  history: TaskHistoryEntry[];
}
