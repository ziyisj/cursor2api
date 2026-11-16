/**
 * Browser login for the console.
 *
 * Same deep-link Cursor's CLI uses: the page shows a loginDeepControl URL, the
 * operator approves it in any browser, and the server polls api2.cursor.sh until
 * the tokens arrive. The verifier never leaves this process, and the poll
 * response the console sees has no token fields.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AccountPool } from "../auth.js";
import { h2Request } from "./h2.js";

const LOGIN_URL = "https://www.cursor.com/loginDeepControl";
const POLL_BASE = "https://api2.cursor.sh";
const TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const POLL_EVERY_MS = 2_000;
/** Cursor's poll route rejects unfamiliar clients. Match the IDE header set. */
const POLL_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cursor/1.0.0 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36";

interface Attempt {
  id: string;
  uuid: string;
  verifier: string;
  url: string;
  label: string;
  createdAt: number;
  status: "pending" | "ready" | "error";
  accountLabel?: string;
  replaced?: boolean;
  error?: string;
  inflight?: Promise<LoginStatus>;
  failures: number;
}

export interface LoginStatus {
  status: "pending" | "ready" | "expired" | "error";
  label?: string;
  replaced?: boolean;
  error?: string;
}

const attempts = new Map<string, Attempt>();

export function beginLogin(
  label: string,
  pool: AccountPool,
  proxyUrl: string | undefined,
): { id: string; url: string; expiresAt: string } {
  const now = Date.now();
  for (const [id, attempt] of attempts) {
    if (now - attempt.createdAt > TTL_MS) attempts.delete(id);
  }
  while (attempts.size >= MAX_ATTEMPTS) {
    const oldest = attempts.keys().next().value;
    if (!oldest) break;
    attempts.delete(oldest);
  }
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  const uuid = randomUUID();
  const id = randomUUID();
  const url =
    `${LOGIN_URL}?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli`;
  const attempt: Attempt = {
    id,
    uuid,
    verifier,
    url,
    label: label.trim(),
    createdAt: now,
    status: "pending",
    failures: 0,
  };
  attempts.set(id, attempt);
  void watch(attempt, pool, proxyUrl);
  return { id, url, expiresAt: new Date(now + TTL_MS).toISOString() };
}

/** One poll tick. Pending means the operator has not approved the link yet. */
export function advanceLogin(id: string, pool: AccountPool, proxyUrl: string | undefined): Promise<LoginStatus> {
  const attempt = attempts.get(id);
  if (!attempt) return Promise.resolve({ status: "error", error: "登录会话不存在或已结束" });
  if (Date.now() - attempt.createdAt > TTL_MS) {
    attempts.delete(id);
    return Promise.resolve({ status: "expired", error: "登录链接已过期，请重新生成" });
  }
  if (attempt.status === "ready") {
    return Promise.resolve({ status: "ready", label: attempt.accountLabel, replaced: attempt.replaced });
  }
  if (attempt.status === "error") return Promise.resolve({ status: "error", error: attempt.error });
  if (!attempt.inflight) {
    attempt.inflight = poll(attempt, pool, proxyUrl).finally(() => {
      attempt.inflight = undefined;
    });
  }
  return attempt.inflight;
}

async function watch(attempt: Attempt, pool: AccountPool, proxyUrl: string | undefined): Promise<void> {
  while (attempt.status === "pending" && Date.now() - attempt.createdAt < TTL_MS) {
    await poll(attempt, pool, proxyUrl);
    if (attempt.status !== "pending") return;
    await new Promise((resolve) => setTimeout(resolve, POLL_EVERY_MS));
  }
  if (attempt.status === "pending") {
    attempt.status = "error";
    attempt.error = "登录链接已过期，请重新生成";
  }
}

async function poll(attempt: Attempt, pool: AccountPool, proxyUrl: string | undefined): Promise<LoginStatus> {
  // POST keeps the verifier out of the URL. Cursor still answers the older GET
  // form, and a finished login can show up on only one of them, so try both.
  const posted = await ask(attempt, proxyUrl, "POST");
  const got = posted.tokens ? posted : await ask(attempt, proxyUrl, "GET");
  if (!posted.tokens && !got.tokens) {
    note(`${attempt.id.slice(0, 8)} post=${posted.status ?? posted.error} get=${got.status ?? got.error}`);
  }
  if (got.tokens) {
    try {
      const label = chooseLabel(attempt.label, got.tokens.accessToken, got.tokens.authId, pool);
      const saved = pool.add(
        {
          label,
          accessToken: got.tokens.accessToken,
          ...(got.tokens.refreshToken ? { refreshToken: got.tokens.refreshToken } : {}),
        },
        true,
      );
      attempt.status = "ready";
      attempt.accountLabel = saved.label;
      attempt.replaced = saved.replaced;
      attempt.verifier = "";
      note(`${attempt.id.slice(0, 8)} ready label=${saved.label}`);
      return { status: "ready", label: saved.label, replaced: saved.replaced };
    } catch (err) {
      attempt.status = "error";
      attempt.error = (err as Error).message;
      return { status: "error", error: attempt.error };
    }
  }
  if (got.pending) {
    attempt.failures = 0;
    return { status: "pending" };
  }
  attempt.failures += 1;
  if (attempt.failures < 5) return { status: "pending" };
  attempt.status = "error";
  attempt.error = got.error ?? `Cursor 登录返回 HTTP ${got.status ?? "?"}`;
  return { status: "error", error: attempt.error };
}

interface PollReply {
  status?: number;
  pending: boolean;
  error?: string;
  tokens?: { accessToken: string; refreshToken?: string; authId?: string };
}

async function ask(attempt: Attempt, proxyUrl: string | undefined, method: "POST" | "GET"): Promise<PollReply> {
  const query = `/auth/poll?uuid=${encodeURIComponent(attempt.uuid)}&verifier=${encodeURIComponent(attempt.verifier)}`;
  try {
    const res = await h2Request({
      baseUrl: POLL_BASE,
      path: method === "POST" ? "/auth/poll" : query,
      proxyUrl,
      timeoutMs: 12_000,
      ...(method === "POST"
        ? { body: Buffer.from(JSON.stringify({ uuid: attempt.uuid, verifier: attempt.verifier })) }
        : {}),
      headers: {
        ":method": method,
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": POLL_UA,
        "x-cursor-client-type": "ide",
      },
    });
    if (res.status === 404 || res.status === 202) return { status: res.status, pending: true };
    if (res.status < 200 || res.status >= 300) {
      return { status: res.status, pending: false, error: `Cursor 登录返回 HTTP ${res.status}` };
    }
    const tokens = readTokens(res.body.toString("utf8"));
    if (!tokens) return { status: res.status, pending: true };
    return { status: res.status, pending: false, tokens };
  } catch (err) {
    return { pending: false, error: (err as Error).message };
  }
}

function readTokens(raw: string): { accessToken: string; refreshToken?: string; authId?: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = asRecord(parsed);
  const nested = asRecord(root.data);
  const accessToken =
    text(root.accessToken) || text(root.access_token) || text(root.token) || text(root.apiKey) ||
    text(nested.accessToken) || text(nested.access_token);
  if (!accessToken) return null;
  const refreshToken = text(root.refreshToken) || text(root.refresh_token) || text(nested.refreshToken);
  const authId = text(root.authId) || text(root.auth_id) || text(nested.authId);
  return { accessToken, ...(refreshToken ? { refreshToken } : {}), ...(authId ? { authId } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function note(message: string): void {
  process.stdout.write(`${new Date().toISOString()} login ${message}\n`);
}

function chooseLabel(requested: string, accessToken: string, authId: string | undefined, pool: AccountPool): string {
  if (requested) return requested;
  const claims = jwtObject(accessToken);
  const email = typeof claims.email === "string" ? claims.email : "";
  if (email && safeLabel(email)) return email;
  const tail = (authId ?? "").split("|").pop() ?? "";
  const cleaned = tail.replace(/[\s/\\#?%]/g, "_").slice(0, 64);
  if (cleaned && safeLabel(cleaned)) return cleaned;
  const taken = new Set(pool.inspect().items.map((item) => item.label));
  const base = "cursor";
  if (!taken.has(base)) return base;
  return `cursor-${randomUUID().slice(0, 4)}`;
}

function jwtObject(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function safeLabel(label: string): boolean {
  return label.length >= 1 && label.length <= 64 && !/[\s/\\#?%]/.test(label);
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
