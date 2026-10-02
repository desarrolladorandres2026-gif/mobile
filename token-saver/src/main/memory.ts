import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileMap, ProjectMemory, TaskHistoryEntry } from "../shared/types";

function memoryDir(root: string): string {
  return join(root, ".token-saver");
}

function fileMapPath(root: string): string {
  return join(memoryDir(root), "file-map.json");
}

function historyPath(root: string): string {
  return join(memoryDir(root), "history.json");
}

export function ensureMemoryDir(root: string): void {
  const dir = memoryDir(root);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cacheDir = join(dir, "cache");
  if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
}

export function loadFileMap(root: string): FileMap | null {
  const path = fileMapPath(root);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FileMap;
  } catch {
    return null;
  }
}

export function saveFileMap(root: string, map: FileMap): void {
  ensureMemoryDir(root);
  writeFileSync(fileMapPath(root), JSON.stringify(map, null, 2), "utf-8");
}

export function loadHistory(root: string): TaskHistoryEntry[] {
  const path = historyPath(root);
  if (!existsSync(path)) return [];
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as TaskHistoryEntry[];
  } catch {
    return [];
  }
}

export function appendHistory(root: string, entry: TaskHistoryEntry): void {
  ensureMemoryDir(root);
  const history = loadHistory(root);
  history.unshift(entry);
  writeFileSync(historyPath(root), JSON.stringify(history.slice(0, 200), null, 2), "utf-8");
}

export function loadProjectMemory(root: string): ProjectMemory {
  const map = loadFileMap(root);
  return {
    root,
    lastFileMapAt: map?.generatedAt ?? 0,
    history: loadHistory(root),
  };
}

/** Busca en el historial una tarea previa cuyas palabras clave se solapen con la actual. */
export function findPreviousWork(root: string, taskKeywords: Set<string>): TaskHistoryEntry[] {
  const history = loadHistory(root);
  return history
    .filter((entry) => {
      const entryKeywords = extractKeywords(entry.task);
      const overlap = [...taskKeywords].filter((k) => entryKeywords.has(k));
      return overlap.length >= Math.min(2, taskKeywords.size);
    })
    .slice(0, 3);
}

export function extractKeywords(text: string): Set<string> {
  const stopwords = new Set([
    "el",
    "la",
    "los",
    "las",
    "de",
    "del",
    "en",
    "y",
    "a",
    "que",
    "para",
    "con",
    "un",
    "una",
    "corrige",
    "corregir",
    "arregla",
    "implementa",
    "agrega",
    "crea",
    "the",
    "and",
    "for",
    "fix",
    "add",
  ]);
  return new Set(
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9áéíóúñ]+/)
      .filter((word) => word.length > 2 && !stopwords.has(word))
  );
}
