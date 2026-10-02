import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runGit(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

export async function getRecentlyChangedFiles(root: string): Promise<string[]> {
  const [uncommitted, lastCommits] = await Promise.all([
    runGit(root, ["status", "--porcelain"]),
    runGit(root, ["log", "-n", "10", "--name-only", "--pretty=format:"]),
  ]);

  const fromStatus = uncommitted
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);

  const fromCommits = lastCommits
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return Array.from(new Set([...fromStatus, ...fromCommits]));
}

export async function getCurrentBranch(root: string): Promise<string> {
  const out = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return out.trim();
}
