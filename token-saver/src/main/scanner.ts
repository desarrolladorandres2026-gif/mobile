import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import type { FileEntry, FileMap } from "../shared/types";
import { estimateTokensForSize } from "./tokenEstimate";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".token-saver",
  ".next",
  ".expo",
  "android/.gradle",
  "ios/Pods",
]);

const IGNORED_FILE_PATTERNS = [/^\.env(\..*)?$/, /\.log$/, /\.lock$/];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".icns",
  ".pdf",
  ".zip",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".woff",
  ".woff2",
  ".ttf",
  ".mp4",
  ".mp3",
  ".db",
  ".sqlite",
]);

const MAX_FILE_BYTES_FOR_HASH = 256 * 1024;

export function isIgnoredFile(name: string): boolean {
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isBinaryExtension(name: string): boolean {
  return BINARY_EXTENSIONS.has(extname(name).toLowerCase());
}

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".token-saver" && entry.isDirectory()) {
      if (entry.name === ".git") continue;
    }
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(join(dir, entry.name), root, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isIgnoredFile(entry.name)) continue;
    if (isBinaryExtension(entry.name)) continue;
    out.push(join(dir, entry.name));
  }
}

function hashFile(absPath: string, sizeBytes: number): string {
  const buffer = readFileSync(absPath);
  const slice = sizeBytes > MAX_FILE_BYTES_FOR_HASH ? buffer.subarray(0, MAX_FILE_BYTES_FOR_HASH) : buffer;
  return createHash("sha1").update(slice).update(String(sizeBytes)).digest("hex");
}

export async function scanProject(
  root: string,
  onProgress?: (scanned: number, total: number) => void
): Promise<FileMap> {
  const absolutePaths: string[] = [];
  await walk(root, root, absolutePaths);

  const files: FileEntry[] = [];
  let scanned = 0;
  for (const absPath of absolutePaths) {
    const stats = statSync(absPath);
    const rel = relative(root, absPath).split("\\").join("/");
    files.push({
      path: rel,
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      hash: hashFile(absPath, stats.size),
      tokensEstimate: estimateTokensForSize(stats.size),
    });
    scanned += 1;
    if (onProgress && scanned % 25 === 0) onProgress(scanned, absolutePaths.length);
  }
  onProgress?.(scanned, absolutePaths.length);

  return {
    root,
    generatedAt: Date.now(),
    hasGit: fileExists(join(root, ".git")),
    files,
  };
}

function fileExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

export function diffFileMaps(previous: FileMap | null, next: FileMap): string[] {
  if (!previous) return next.files.map((f) => f.path);
  const prevByPath = new Map(previous.files.map((f) => [f.path, f]));
  const changed: string[] = [];
  for (const file of next.files) {
    const prev = prevByPath.get(file.path);
    if (!prev || prev.hash !== file.hash) changed.push(file.path);
  }
  return changed;
}
