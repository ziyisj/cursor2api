/**
 * Browser console.
 *
 * Files in web/ are served at /console with no API key, so the page can load
 * and then ask for one. GET /console/api/status is the only console route that
 * reads process state; it uses the same bearer check as the OpenAI routes and
 * the account rows it returns are built without token fields.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountPool } from "./auth.js";
import { advanceLogin, beginLogin } from "./cursor/login.js";
import type { Config } from "./config.js";

const bootedAt = Date.now();

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export interface ConsoleStatus {
  ok: true;
  uptimeSec: number;
  accounts: ReturnType<AccountPool["inspect"]>;
  config: {
    modelPrefix: string;
    allowedNativeTools: string[];
    nativeToolsOpen: boolean;
    proxyEnabled: boolean;
    systemAsHistory: boolean;
    timeoutMs: number;
    clientVersion: string;
    apiKeyRequired: boolean;
    logRequests: boolean;
    upstream: string;
  };
}

/**
 * Directory of this module when the runtime can see it. A CJS bundle leaves
 * `import.meta.url` empty, so callers also try cwd and CURSOR_DIRECT_WEB_DIR.
 */
function moduleDir(): string | undefined {
  try {
    const url = import.meta.url;
    if (!url) return undefined;
    return path.dirname(fileURLToPath(url));
  } catch {
    return undefined;
  }
}

export function resolveWebRoot(): string {
  const fromEnv = process.env.CURSOR_DIRECT_WEB_DIR;
  if (fromEnv && fromEnv.trim() !== "") return path.resolve(fromEnv);
  const here = moduleDir();
  const candidates = [path.resolve(process.cwd(), "web")];
  if (here) candidates.push(path.resolve(here, "../web"));
  for (const dir of candidates) {
    if (existsSync(path.join(dir, "index.html"))) return dir;
  }
  return candidates[0] ?? path.resolve("web");
}

/**
 * Map a /console URL onto a file inside webRoot, or null when the path escapes
 * the directory. `/console` and `/console/` both mean index.html. The status
 * route is not a file and resolves to null.
 */
export function resolveConsoleFile(pathname: string, root = resolveWebRoot()): string | null {
  if (pathname !== "/console" && !pathname.startsWith("/console/")) return null;
  if (pathname.startsWith("/console/api/")) return null;
  let rel = pathname.slice("/console".length).replace(/^\/+/, "");
  if (rel === "") rel = "index.html";
  if (rel.includes("\\") || rel.includes("\0")) return null;
  const base = path.resolve(root);
  const file = path.resolve(base, rel);
  const relTo = path.relative(base, file);
  if (relTo.startsWith("..") || path.isAbsolute(relTo)) return null;
  return file;
}

export function buildStatus(deps: { config: Config; pool: AccountPool }): ConsoleStatus {
  const { config, pool } = deps;
  return {
    ok: true,
    uptimeSec: Math.max(0, Math.floor((Date.now() - bootedAt) / 1000)),
    accounts: pool.inspect(),
    config: {
      modelPrefix: config.modelPrefix,
      allowedNativeTools: config.allowedNativeTools,
      nativeToolsOpen: config.allowedNativeTools.length === 0,
      proxyEnabled: Boolean(config.proxyUrl),
      systemAsHistory: config.systemAsHistory,
      timeoutMs: config.requestTimeoutMs,
      clientVersion: config.clientVersion,
      apiKeyRequired: Boolean(config.apiKey),
      logRequests: config.logRequests,
      upstream: config.cursorBaseUrl,
    },
  };
}

export function serveConsole(res: ServerResponse, pathname: string, method: string): void {
  const file = resolveConsoleFile(pathname);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    writeJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
    return;
  }
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "content-length": statSync(file).size,
    "cache-control": "no-cache",
    ...SECURITY_HEADERS,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) {
      writeJson(res, 500, { error: { message: "failed to read console asset" } });
    } else {
      res.destroy();
    }
  });
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Account pool edits from the console. Responses never include token fields.
 * `/console/api/accounts` creates one; `/:label` deletes it;
 * `/:label/schedulable` and `/:label/clear-cooldown` change rotation membership.
 */
export async function handleAccountApi(
  req: IncomingMessage,
  res: ServerResponse,
  pool: AccountPool,
  pathname: string,
  proxyUrl: string | undefined,
): Promise<void> {
  const route = accountRoute(pathname);
  if (!route) {
    writeJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
    return;
  }
  try {
    if (route.kind === "login") {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
        return;
      }
      const raw = await readJsonBody(req);
      const body = raw.trim() ? (JSON.parse(raw) as { label?: string }) : {};
      const label = (body.label ?? "").trim();
      if (label && !/^[^\s/\\#?%]{1,128}$/.test(label)) {
        writeJson(res, 400, { error: { message: "账号标签只能用 1–128 位、不能含空格或 / \\", type: "invalid_request_error" } });
        return;
      }
      const started = beginLogin(label, pool, proxyUrl);
      writeJson(res, 200, started);
      return;
    }
    if (route.kind === "login-poll") {
      if (req.method !== "GET" && req.method !== "HEAD") {
        writeJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
        return;
      }
      const status = await advanceLogin(route.id, pool, proxyUrl);
      writeJson(res, 200, status);
      return;
    }
    if (route.kind === "collection") {
      if (req.method !== "POST") {
        writeJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
        return;
      }
      const body = JSON.parse(await readJsonBody(req)) as {
        label?: string;
        accessToken?: string;
        refreshToken?: string;
      };
      pool.add({
        label: body.label ?? "",
        accessToken: body.accessToken ?? "",
        ...(body.refreshToken ? { refreshToken: body.refreshToken } : {}),
      });
      writeJson(res, 200, { ok: true, label: body.label?.trim() ?? "" });
      return;
    }
    if (req.method !== "POST" && req.method !== "DELETE") {
      writeJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
      return;
    }
    if (route.action === "" && req.method === "DELETE") {
      pool.remove(route.label);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (route.action === "clear-cooldown" && req.method === "POST") {
      pool.clearCooldown(route.label);
      writeJson(res, 200, { ok: true });
      return;
    }
    if (route.action === "schedulable" && req.method === "POST") {
      const body = JSON.parse(await readJsonBody(req)) as { schedulable?: boolean };
      if (typeof body.schedulable !== "boolean") {
        writeJson(res, 400, { error: { message: "schedulable must be a boolean", type: "invalid_request_error" } });
        return;
      }
      pool.setSchedulable(route.label, body.schedulable);
      writeJson(res, 200, { ok: true });
      return;
    }
    writeJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
  } catch (err) {
    const message = (err as Error).message;
    const status = message === "account not found" ? 404 : message.includes("已经在池子里") ? 409 : 400;
    writeJson(res, status, { error: { message, type: "invalid_request_error" } });
  }
}

function accountRoute(pathname: string):
  | { kind: "collection" }
  | { kind: "login" }
  | { kind: "login-poll"; id: string }
  | { kind: "one"; label: string; action: "" | "schedulable" | "clear-cooldown" }
  | null {
  if (pathname === "/console/api/accounts") return { kind: "collection" };
  if (pathname === "/console/api/accounts/login") return { kind: "login" };
  const loginPrefix = "/console/api/accounts/login/";
  if (pathname.startsWith(loginPrefix)) {
    const id = pathname.slice(loginPrefix.length);
    if (!id || id.includes("/")) return null;
    return { kind: "login-poll", id };
  }
  const prefix = "/console/api/accounts/";
  if (!pathname.startsWith(prefix)) return null;
  const parts = pathname.slice(prefix.length).split("/");
  if (parts.length === 0 || parts.length > 2 || parts.some((part) => part.length === 0)) return null;
  const label = parts[0] ?? "";
  const action = parts[1] ?? "";
  if (action !== "" && action !== "schedulable" && action !== "clear-cooldown") return null;
  return { kind: "one", label, action };
}

function readJsonBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
