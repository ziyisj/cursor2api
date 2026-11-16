/**
 * The caller key third-party platforms send as `Authorization: Bearer …`.
 *
 * The console can set it without already knowing it. The value lives in
 * settings.json (mode 0600) and overrides CURSOR_DIRECT_API_KEY, so a change
 * made in the browser survives a restart. The key is never written to git.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";

export function settingsFile(): string {
  const fromEnv = process.env.CURSOR_DIRECT_SETTINGS_FILE;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "settings.json");
}

export function applyStoredSettings(config: Config): void {
  const saved = readStoredApiKey();
  if (saved) config.apiKey = saved;
}

export function readStoredApiKey(): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), "utf8")) as { apiKey?: unknown };
    if (typeof parsed.apiKey !== "string") return undefined;
    const trimmed = parsed.apiKey.trim();
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

export function saveApiKey(config: Config, apiKey: string): void {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8 || trimmed.length > 200 || /\s/.test(trimmed)) {
    throw new Error("调用密钥需要 8–200 位，且不能包含空格");
  }
  const file = settingsFile();
  writeFileSync(file, `${JSON.stringify({ apiKey: trimmed }, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* Windows may refuse the Unix mode. */
  }
  config.apiKey = trimmed;
  rememberInEnvFile(trimmed);
}

function rememberInEnvFile(apiKey: string): void {
  const fromEnv = process.env.CURSOR_DIRECT_ENV_FILE;
  const file = fromEnv && fromEnv.trim() !== "" ? path.resolve(fromEnv) : path.resolve(process.cwd(), ".env");
  let lines: string[] = [];
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    lines = [];
  }
  const prefix = "CURSOR_DIRECT_API_KEY=";
  let found = false;
  const next = lines.map((line) => {
    if (!line.startsWith(prefix)) return line;
    found = true;
    return prefix + apiKey;
  });
  if (!found) next.push(prefix + apiKey);
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  try {
    writeFileSync(file, `${next.join("\n")}\n`, { mode: 0o600 });
  } catch {
    /* The settings file is already the source of truth. */
  }
}
