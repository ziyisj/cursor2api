/**
 * OpenAI-compatible HTTP surface, plus the browser console.
 *
 * Routes: GET /health, GET /v1/models, POST /v1/chat/completions,
 * GET /console (static), GET /console/api/status.
 * Designed to sit on 127.0.0.1 behind CLIProxyAPI's `openai-compatibility`
 * upstream. There is no CORS: the console is served by this process and talks
 * to it on the same origin. `/` and `/health` stay JSON so healthchecks do not
 * start receiving HTML.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Config } from "./config.js";
import { failoverCooldownMs, type Account, type AccountPool } from "./auth.js";
import { buildStatus, handleAccountApi, serveConsole } from "./console.js";
import { saveApiKey } from "./settings.js";
import { UPDATE_RESTART_CODE, applyUpdate, checkForUpdate } from "./update.js";
import { listModelIds, toModelList, upstreamId } from "./models.js";
import { runTurn, type TurnEvent } from "./cursor/session.js";
import { buildTurnInput, type OpenAIChatRequest } from "./openai/translate.js";

export interface ServerDeps {
  config: Config;
  pool: AccountPool;
  log: (msg: string) => void;
}

export function createServer(deps: ServerDeps): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, deps).catch((err: unknown) => {
      deps.log(`unhandled: ${(err as Error).message}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: (err as Error).message } });
      else res.end();
    });
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /health" || route === "GET /") {
    sendJson(res, 200, { ok: true, accounts: deps.pool.size(), models: "dynamic" });
    return;
  }

  if (url.pathname === "/console" || url.pathname.startsWith("/console/")) {
    if (url.pathname === "/console/api/settings" || url.pathname === "/console/api/settings/") {
      await handleSettings(req, res, deps);
      return;
    }
    if (url.pathname === "/console/api/update" || url.pathname === "/console/api/update/") {
      await handleUpdate(req, res, deps);
      return;
    }
    if (url.pathname === "/console/api/accounts" || url.pathname.startsWith("/console/api/accounts/")) {
      await handleAccountApi(req, res, deps.pool, url.pathname, deps.config.proxyUrl);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
      return;
    }
    if (url.pathname === "/console/api/status" || url.pathname === "/console/api/status/") {
      sendJson(res, 200, buildStatus(deps));
      return;
    }
    serveConsole(res, url.pathname, req.method === "HEAD" ? "HEAD" : "GET");
    return;
  }

  const access = modelAccess(req, deps.config);
  if (!access.ok) {
    sendJson(res, 401, { error: { message: access.message, type: "invalid_request_error" } });
    return;
  }

  if (route === "GET /v1/models") {
    const account = await deps.pool.peek();
    const ids = await listModelIds(account.accessToken, deps.config);
    sendJson(res, 200, { object: "list", data: toModelList(ids, deps.config.modelPrefix) });
    return;
  }

  if (route === "POST /v1/chat/completions") {
    await chatCompletions(req, res, deps, url);
    return;
  }

  sendJson(res, 404, { error: { message: `no route for ${route}`, type: "invalid_request_error" } });
}

function presentedKey(req: http.IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const alt = (req.headers["x-api-key"] as string | undefined) ?? "";
  return bearer || alt;
}

/** Third-party platforms must present the key. Until one is set, model calls stay closed. */
function modelAccess(req: http.IncomingMessage, config: Config): { ok: true } | { ok: false; message: string } {
  if (!config.apiKey) {
    return { ok: false, message: "还没有调用密钥。请先在控制台的设置里添加，再交给第三方平台。" };
  }
  if (presentedKey(req) === config.apiKey) return { ok: true };
  return { ok: false, message: "调用密钥不正确" };
}

async function handleSettings(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  if (req.method === "GET" || req.method === "HEAD") {
    sendJson(res, 200, { apiKeySet: Boolean(deps.config.apiKey), apiKey: deps.config.apiKey ?? "" });
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
    return;
  }
  try {
    const body = JSON.parse(await readBody(req)) as { apiKey?: string };
    saveApiKey(deps.config, body.apiKey ?? "");
    sendJson(res, 200, { ok: true, apiKeySet: true, apiKey: deps.config.apiKey ?? "" });
  } catch (err) {
    sendJson(res, 400, { error: { message: (err as Error).message, type: "invalid_request_error" } });
  }
}

async function handleUpdate(req: http.IncomingMessage, res: http.ServerResponse, deps: ServerDeps): Promise<void> {
  if (req.method === "GET" || req.method === "HEAD") {
    sendJson(res, 200, await checkForUpdate());
    return;
  }
  if (req.method !== "POST") {
    sendJson(res, 405, { error: { message: "method not allowed", type: "invalid_request_error" } });
    return;
  }
  try {
    const message = await applyUpdate();
    sendJson(res, 200, { ok: true, message, restarting: true });
    deps.log("update applied, restarting");
    setTimeout(() => process.exit(UPDATE_RESTART_CODE), 400).unref();
  } catch (err) {
    sendJson(res, 500, { error: { message: (err as Error).message, type: "upstream_error" } });
  }
}

async function chatCompletions(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: ServerDeps,
  _url: URL,
): Promise<void> {
  const { config, pool, log } = deps;
  let body: OpenAIChatRequest;
  try {
    body = JSON.parse(await readBody(req)) as OpenAIChatRequest;
  } catch (err) {
    sendJson(res, 400, { error: { message: `bad JSON body: ${(err as Error).message}` } });
    return;
  }

  const clientModel = body.model ?? `${config.modelPrefix}auto`;
  const input = buildTurnInput(body, config);
  const abort = new AbortController();
  req.on("close", () => abort.abort());

  const tried = new Set<string>();
  let lastCode: string | undefined;
  let lastError = "upstream error";
  let lastLabel = "";

  while (tried.size < 32) {
    if (abort.signal.aborted || res.writableEnded) return;
    let account: Account;
    try {
      account = await pool.next();
    } catch (err) {
      if (lastLabel) {
        const mapped = upstreamError(lastCode, lastError);
        sendJson(res, mapped.status, { ...mapped.body, cursor2api_account: lastLabel });
        return;
      }
      const message = (err as Error).message;
      const status = message.includes("cooldown") ? 429 : 503;
      sendJson(res, status, {
        error: { message, type: status === 429 ? "rate_limit_exceeded" : "upstream_error" },
      });
      return;
    }
    if (tried.has(account.label)) {
      const mapped = upstreamError(lastCode, lastError);
      sendJson(res, mapped.status, { ...mapped.body, cursor2api_account: lastLabel || account.label });
      return;
    }
    tried.add(account.label);

    const known = await listModelIds(account.accessToken, config);
    const model = upstreamId(clientModel, config.modelPrefix, known);
    if (config.logRequests) {
      log(
        `chat account=${account.label} model=${model} history=${input.rootMessages.length} ` +
          `tools=${input.tools.length} stream=${Boolean(body.stream)} try=${tried.size} ` +
          `action=${input.userText.trim() ? "user" : "resume"}`,
      );
    }

    const events = runTurn({
      token: account.accessToken,
      model,
      rootMessages: input.rootMessages,
      userText: input.userText,
      tools: input.tools,
      config,
      signal: abort.signal,
    });

    if (body.stream) {
      const outcome = await streamResponse(res, events, clientModel, deps, account.label, abort.signal);
      if (outcome.kind === "ok") {
        pool.noteUse(account);
        return;
      }
      if (outcome.kind === "failover" && !abort.signal.aborted) {
        lastCode = outcome.code;
        lastError = outcome.error ?? "upstream error";
        lastLabel = account.label;
        pool.markFailure(account, lastError, failoverCooldownMs(outcome.code) ?? 60_000);
        continue;
      }
      const wait = failoverCooldownMs(outcome.code);
      if (wait !== null && !abort.signal.aborted) {
        pool.markFailure(account, outcome.error ?? "upstream error", wait);
      }
      return;
    }

    let result: Collected;
    try {
      result = await collect(events);
    } catch (err) {
      if (abort.signal.aborted) return;
      lastCode = "unavailable";
      lastError = (err as Error).message;
      lastLabel = account.label;
      pool.markFailure(account, lastError, failoverCooldownMs("unavailable") ?? 30_000);
      continue;
    }
    if (result.reason === "error") {
      lastCode = result.code;
      lastError = result.error ?? "upstream error";
      lastLabel = account.label;
      const wait = failoverCooldownMs(result.code);
      if (wait !== null && !abort.signal.aborted) {
        pool.markFailure(account, lastError, wait);
        log(`account ${account.label} failed (${result.code ?? "error"}), trying next`);
        continue;
      }
      const mapped = upstreamError(result.code, result.error);
      sendJson(res, mapped.status, { ...mapped.body, cursor2api_account: account.label });
      return;
    }
    pool.noteUse(account);
    sendBuffered(res, result, clientModel, account.label);
    return;
  }
}

const OPENAI_TOOL_TYPE = "function" as const;

interface Collected {
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  usage: { inputTokens?: number; outputTokens?: number };
  reason: "stop" | "tool_calls" | "error";
  error?: string;
  code?: string;
}

async function collect(events: AsyncGenerator<TurnEvent>): Promise<Collected> {
  const out: Collected = { text: "", reasoning: "", toolCalls: [], usage: {}, reason: "stop" };
  for await (const ev of events) {
    if (ev.type === "text") out.text += ev.delta;
    else if (ev.type === "thinking") out.reasoning += ev.delta;
    else if (ev.type === "tool_call") out.toolCalls.push({ id: ev.id, name: ev.name, args: ev.args });
    else if (ev.type === "usage") {
      if (ev.inputTokens !== undefined) out.usage.inputTokens = ev.inputTokens;
      if (ev.outputTokens !== undefined) out.usage.outputTokens = ev.outputTokens;
    } else if (ev.type === "done") {
      out.reason = ev.reason;
      out.error = ev.error;
      out.code = ev.code;
    }
  }
  return out;
}

function sendBuffered(res: http.ServerResponse, result: Collected, clientModel: string, accountLabel: string): void {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const message: Record<string, unknown> = { role: "assistant", content: result.text || null };
  if (result.reasoning) message.reasoning_content = result.reasoning;
  if (result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((c) => ({
      id: c.id,
      type: OPENAI_TOOL_TYPE,
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: clientModel,
    cursor2api_account: accountLabel,
    choices: [
      {
        index: 0,
        message,
        finish_reason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: usageBlock(result.usage),
  });
}

type StreamEnd =
  | { kind: "ok" }
  | { kind: "failover"; code?: string; error?: string }
  | { kind: "answered"; code?: string; error?: string };

async function streamResponse(
  res: http.ServerResponse,
  events: AsyncGenerator<TurnEvent>,
  clientModel: string,
  deps: ServerDeps,
  accountLabel: string,
  signal: AbortSignal,
): Promise<StreamEnd> {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  let opened = false;
  let toolIndex = 0;
  let finish: "stop" | "tool_calls" = "stop";
  const usage: Collected["usage"] = {};

  const open = (): void => {
    if (opened) return;
    opened = true;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const first = chunk(id, created, clientModel, { role: "assistant", content: "" }, null);
    first.cursor2api_account = accountLabel;
    emit(res, first);
  };

  for await (const ev of events) {
    if (ev.type === "text") {
      open();
      emit(res, chunk(id, created, clientModel, { content: ev.delta }, null));
    } else if (ev.type === "thinking") {
      open();
      emit(res, chunk(id, created, clientModel, { reasoning_content: ev.delta }, null));
    } else if (ev.type === "tool_call") {
      open();
      finish = "tool_calls";
      emit(
        res,
        chunk(
          id,
          created,
          clientModel,
          {
            tool_calls: [
              {
                index: toolIndex++,
                id: ev.id,
                type: OPENAI_TOOL_TYPE,
                function: { name: ev.name, arguments: JSON.stringify(ev.args) },
              },
            ],
          },
          null,
        ),
      );
    } else if (ev.type === "usage") {
      if (ev.inputTokens !== undefined) usage.inputTokens = ev.inputTokens;
      if (ev.outputTokens !== undefined) usage.outputTokens = ev.outputTokens;
    } else if (ev.type === "done") {
      if (ev.reason === "error") {
        deps.log(`upstream error (${accountLabel}): ${ev.error}`);
        const wait = failoverCooldownMs(ev.code);
        if (!opened && wait !== null && !signal.aborted) {
          return { kind: "failover", code: ev.code, error: ev.error };
        }
        const { status, body } = upstreamError(ev.code, ev.error);
        const payload = { ...body, cursor2api_account: accountLabel };
        if (!opened) {
          if (!signal.aborted) sendJson(res, status, payload);
          return { kind: "answered", code: ev.code, error: ev.error };
        }
        // Mid-stream failures can only be reported inside the stream.
        emit(res, payload);
        res.write("data: [DONE]\n\n");
        res.end();
        return { kind: "answered", code: ev.code, error: ev.error };
      }
      open();
      const last = chunk(id, created, clientModel, {}, ev.reason === "tool_calls" ? "tool_calls" : finish);
      last.usage = usageBlock(usage);
      emit(res, last);
      res.write("data: [DONE]\n\n");
      res.end();
      return { kind: "ok" };
    }
  }

  // Generator ended without a done event (should not happen) — close cleanly.
  open();
  emit(res, chunk(id, created, clientModel, {}, finish));
  res.write("data: [DONE]\n\n");
  res.end();
  return { kind: "ok" };
}

function chunk(
  id: string,
  created: number,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): Record<string, any> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * Connect codes that a caller can act on differently, mapped to the HTTP status an
 * OpenAI client expects. Quota exhaustion is the one that matters in practice: as a
 * 502 it reads as a broken gateway, so clients and aggregators give up instead of
 * backing off and retrying. Anything unrecognised stays a 502 rather than being
 * dressed up as a client error.
 */
const STATUS_BY_CODE: Record<string, number> = {
  resource_exhausted: 429,
  model_not_included: 402,
  unauthenticated: 401,
  permission_denied: 403,
  invalid_argument: 400,
  not_found: 404,
  unimplemented: 501,
  unavailable: 503,
  deadline_exceeded: 504,
};

function upstreamError(
  code: string | undefined,
  message: string | undefined,
): { status: number; body: { error: { message: string; type: string; code?: string } } } {
  const status = (code ? STATUS_BY_CODE[code] : undefined) ?? 502;
  const type =
    code === "model_not_included" ? "insufficient_quota" : status === 429 ? "rate_limit_exceeded" : "upstream_error";
  return {
    status,
    body: { error: { message: message ?? "upstream error", type, ...(code ? { code } : {}) } },
  };
}

function usageBlock(usage: Collected["usage"]): Record<string, number> {
  const prompt = usage.inputTokens ?? 0;
  const completion = usage.outputTokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

function emit(res: http.ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
