/**
 * Compare this checkout with ziyisj/cursor2api main, then fast-forward and
 * reinstall. The process exits with UPDATE_RESTART_CODE so deploy.mjs starts
 * it again. A plain `node` start has to be launched once more by hand.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const UPDATE_RESTART_CODE = 75;
const REPO = "ziyisj/cursor2api";
const BRANCH = "main";

export function describeUpdate(local: string | null, remote: string | null): "current" | "available" | "unknown" {
  if (!local || !remote) return "unknown";
  return local === remote ? "current" : "available";
}

export interface UpdateStatus {
  local: string | null;
  remote: string | null;
  state: "current" | "available" | "unknown";
  message: string;
}

export async function checkForUpdate(cwd = process.cwd()): Promise<UpdateStatus> {
  const local = await localHead(cwd);
  let remote: string | null = null;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "cursor2api" },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const body = (await res.json()) as { sha?: string };
      if (typeof body.sha === "string" && body.sha) remote = body.sha;
    }
  } catch {
    /* leave remote empty and explain below */
  }
  const state = describeUpdate(local, remote);
  let message = "已是 GitHub 上的最新版本。";
  if (!local) message = "当前目录不是 git 仓库，不能在线更新。";
  else if (!remote) message = "没有连上 GitHub，暂时不知道有没有新版本。";
  else if (state === "available") message = "GitHub 上有新版本。";
  return { local, remote, state, message };
}

export async function applyUpdate(cwd = process.cwd()): Promise<string> {
  const pulled = await git(["pull", "--ff-only", "origin", BRANCH], cwd);
  if (pulled.code !== 0) {
    throw new Error(pulled.stderr.trim() || "git pull 失败");
  }
  const installed = await run(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund"], cwd, true);
  if (installed.code !== 0) {
    throw new Error(installed.stderr.trim() || "npm install 失败");
  }
  return pulled.stdout.trim() || "已更新";
}

async function localHead(cwd: string): Promise<string | null> {
  const result = await git(["rev-parse", "HEAD"], cwd);
  if (result.code !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

function gitBins(): string[] {
  const bins = ["git"];
  if (process.platform === "win32") bins.push("C:\\Program Files\\Git\\cmd\\git.exe");
  return bins;
}

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  let last = { code: 1, stdout: "", stderr: "找不到 git" };
  for (const bin of gitBins()) {
    if (bin.includes("\\") && !existsSync(bin)) continue;
    const result = await run(bin, args, cwd, false);
    if (result.missing) continue;
    last = result;
    if (result.code === 0 || result.stderr.trim()) return result;
  }
  return last;
}

function run(
  command: string,
  args: string[],
  cwd: string,
  shell: boolean,
): Promise<{ code: number; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true, timeout: 180_000, shell }, (err, stdout, stderr) => {
      const failure = err as NodeJS.ErrnoException | null;
      const missing = failure?.code === "ENOENT";
      const code = typeof failure?.code === "number" ? failure.code : failure ? 1 : 0;
      resolve({
        code,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? (failure && !missing ? failure.message : "")),
        missing,
      });
    });
  });
}
