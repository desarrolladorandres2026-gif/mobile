import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import type {
  ContextFileResult,
  FileMap,
  OptimizationMode,
  OptimizationResult,
  PreviousWorkMatch,
} from "../shared/types";
import { estimateTokens } from "./tokenEstimate";
import { extractKeywords, findPreviousWork } from "./memory";

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const IMPORT_PATTERN = /(?:from\s+|require\()\s*["']([^"']+)["']/g;

interface ModeConfig {
  dependencyDepth: number;
  keywordScoreThreshold: number;
}

function resolveModeConfig(mode: OptimizationMode, seedCount: number): ModeConfig {
  switch (mode) {
    case "agresivo":
      return { dependencyDepth: 0, keywordScoreThreshold: 2 };
    case "completo":
      return { dependencyDepth: 2, keywordScoreThreshold: 1 };
    case "normal":
      return { dependencyDepth: 1, keywordScoreThreshold: 1 };
    case "inteligente":
    default:
      return { dependencyDepth: seedCount <= 3 ? 2 : 1, keywordScoreThreshold: 1 };
  }
}

function scorePathAgainstKeywords(path: string, keywords: Set<string>): number {
  const normalized = path.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) score += 1;
  }
  return score;
}

function resolveImportTarget(fromRelPath: string, specifier: string, allPaths: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const fromDir = dirname(fromRelPath);
  const base = posix.normalize(join(fromDir, specifier).split("\\").join("/"));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const candidate of candidates) {
    if (allPaths.has(candidate)) return candidate;
  }
  return null;
}

function extractImports(root: string, relPath: string, allPaths: Set<string>): string[] {
  const ext = relPath.slice(relPath.lastIndexOf("."));
  if (!CODE_EXTENSIONS.has(ext)) return [];
  let content: string;
  try {
    content = readFileSync(join(root, relPath), "utf-8");
  } catch {
    return [];
  }
  const targets: string[] = [];
  for (const match of content.matchAll(IMPORT_PATTERN)) {
    const resolved = resolveImportTarget(relPath, match[1], allPaths);
    if (resolved) targets.push(resolved);
  }
  return targets;
}

export function buildContext(
  root: string,
  fileMap: FileMap,
  task: string,
  mode: OptimizationMode,
  recentlyChanged: string[]
): OptimizationResult {
  const allPaths = new Set(fileMap.files.map((f) => f.path));
  const tokensByPath = new Map(fileMap.files.map((f) => [f.path, f.tokensEstimate]));
  const keywords = extractKeywords(task);

  const seedScores = new Map<string, number>();
  for (const file of fileMap.files) {
    const score = scorePathAgainstKeywords(file.path, keywords);
    if (score > 0) seedScores.set(file.path, score);
  }

  const modeConfig = resolveModeConfig(mode, seedScores.size);
  const seedFiles = [...seedScores.entries()]
    .filter(([, score]) => score >= modeConfig.keywordScoreThreshold)
    .map(([path]) => path);

  const included = new Map<string, string>(); // path -> reason
  for (const path of seedFiles) {
    included.set(path, "coincide con palabras clave de la tarea");
  }

  let frontier = [...seedFiles];
  for (let depth = 0; depth < modeConfig.dependencyDepth; depth += 1) {
    const nextFrontier: string[] = [];
    for (const path of frontier) {
      for (const dependency of extractImports(root, path, allPaths)) {
        if (!included.has(dependency)) {
          included.set(
            dependency,
            `dependencia directa de ${path} (nivel ${depth + 1})`
          );
          nextFrontier.push(dependency);
        }
      }
    }
    frontier = nextFrontier;
  }

  const relevantRecentlyChanged = recentlyChanged.filter(
    (path) => allPaths.has(path) && scorePathAgainstKeywords(path, keywords) > 0
  );
  for (const path of relevantRecentlyChanged) {
    if (!included.has(path)) included.set(path, "cambiado recientemente y relacionado con la tarea");
  }

  const previousWork: PreviousWorkMatch[] = findPreviousWork(root, keywords).map((entry) => ({
    summary: entry.summaryForFutureReuse ?? entry.task,
    date: new Date(entry.createdAt).toISOString().slice(0, 10),
    filesCovered: entry.filesIncluded,
  }));

  const files: ContextFileResult[] = [];
  for (const [path, reason] of included) {
    files.push({
      path,
      included: true,
      reason,
      tokensEstimate: tokensByPath.get(path) ?? 0,
    });
  }

  const excludedSample = fileMap.files
    .filter((f) => !included.has(f.path) && (seedScores.get(f.path) ?? 0) > 0)
    .slice(0, 15)
    .map((f) => ({
      path: f.path,
      included: false,
      reason: "coincidencia débil con la tarea, por debajo del umbral del modo",
      tokensEstimate: f.tokensEstimate,
    }));
  files.push(...excludedSample);

  const tokensWithoutOptimization = fileMap.files.reduce((sum, f) => sum + f.tokensEstimate, 0);
  const tokensSelected = [...included.keys()].reduce((sum, path) => sum + (tokensByPath.get(path) ?? 0), 0);
  const tokensSaved = Math.max(0, tokensWithoutOptimization - tokensSelected);
  const savingsPercent = tokensWithoutOptimization === 0 ? 0 : Math.round((tokensSaved / tokensWithoutOptimization) * 100);

  const prompt = buildPrompt({
    task,
    includedPaths: [...included.keys()],
    previousWork,
    recentlyChanged: relevantRecentlyChanged,
  });

  return {
    task,
    mode,
    files,
    previousWork,
    recentlyChanged: relevantRecentlyChanged,
    tokensWithoutOptimization,
    tokensSelected,
    tokensSaved,
    savingsPercent,
    prompt,
    createdAt: Date.now(),
  };
}

function buildPrompt(args: {
  task: string;
  includedPaths: string[];
  previousWork: PreviousWorkMatch[];
  recentlyChanged: string[];
}): string {
  const { task, includedPaths, previousWork, recentlyChanged } = args;
  const lines: string[] = [];
  lines.push("TAREA:");
  lines.push(task.trim());
  lines.push("");
  lines.push("CONTEXTO RELEVANTE:");
  for (const path of includedPaths) lines.push(`- ${path}`);
  lines.push("");

  if (previousWork.length > 0) {
    lines.push("CONTEXTO EXISTENTE:");
    for (const entry of previousWork) {
      lines.push(`- ${entry.summary} (${entry.date})`);
    }
    lines.push("");
  }

  if (recentlyChanged.length > 0) {
    lines.push("CAMBIOS RECIENTES:");
    for (const path of recentlyChanged) lines.push(`- ${path}`);
    lines.push("");
  }

  lines.push("INSTRUCCIONES:");
  lines.push("1. Analiza primero los archivos indicados en CONTEXTO RELEVANTE.");
  lines.push("2. No recorras todo el proyecto.");
  if (previousWork.length > 0) {
    lines.push("3. Reutiliza el contexto existente; verifica únicamente los cambios posteriores.");
  } else {
    lines.push("3. No existe contexto previo registrado para esta tarea.");
  }
  lines.push("4. Si necesitas otro archivo fuera de esta lista, justifica por qué antes de leerlo.");
  lines.push("5. Implementa la solución y ejecuta las pruebas relacionadas.");

  return lines.join("\n");
}

export { extractKeywords };
