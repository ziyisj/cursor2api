import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountPool } from "../src/auth.ts";
import { resolveConsoleFile } from "../src/console.ts";
import type { Config } from "../src/config.ts";
import { createServer } from "../src/server.ts";

function jwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ exp: expSec, sub: "user" })).toString("base64url");
  return `${header}.${body}.sig`;
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) keysDeep(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      out.push(key);
      keysDeep(inner, out);
    }
  }
  return out;
}

test("console files cannot escape the web directory", () => {
  const root = path.resolve("web");
  const index = resolveConsoleFile("/console", root);
  assert.equal(index, path.join(root, "index.html"));
  assert.equal(resolveConsoleFile("/console/", root), path.join(root, "index.html"));
  assert.equal(resolveConsoleFile("/console/api/status", root), null);
  assert.equal(resolveConsoleFile("/console/../../package.json", root), null);
  assert.equal(resolveConsoleFile("/console/foo/../../../package.json", root), null);
  assert.equal(resolveConsoleFile("/console/..\\..\\package.json", root), null);
});

test("status omits tokens and the console is served beside /health", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cursor2api-console-"));
  const authFile = path.join(dir, "accounts.json");
  const access = jwt(Math.floor(Date.now() / 1000) + 86_400);
  const spare = jwt(Math.floor(Date.now() / 1000) + 3_600);
  const refresh = "refresh-secret-value";
  const otherRefresh = "other-refresh-secret";
  writeFileSync(
    authFile,
    JSON.stringify([
      { label: "desk", accessToken: access, refreshToken: refresh },
      {
        label: "spare",
        accessToken: spare,
        refreshToken: otherRefresh,
        disabledUntil: new Date(Date.now() + 60_000).toISOString(),
        lastError: "boom",
      },
    ]),
  );

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    apiKey: "console-test-key",
    cursorBaseUrl: "https://api2.cursor.sh",
    proxyUrl: undefined,
    clientVersion: "cli-test",
    allowedNativeTools: ["mcp_tool_call"],
    modelPrefix: "cursor-",
    authFile,
    requestTimeoutMs: 30_000,
    systemAsHistory: true,
    continuationPrompt: "Continue",
    logRequests: false,
  };
  const pool = new AccountPool(authFile, () => {});
  const server = createServer({ config, pool, log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const page = await fetch(`${base}/console`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await page.text(), /id="page-overview"/);

    const asset = await fetch(`${base}/console/app.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type") ?? "", /javascript/);

    const head = await fetch(`${base}/console/app.css`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    const status = await fetch(`${base}/console/api/status`);
    assert.equal(status.status, 200);
    const body = await status.json();
    const encoded = JSON.stringify(body);
    assert.equal(body.accounts.total, 2);
    assert.equal(body.accounts.healthy, 1);
    assert.equal(body.accounts.items[0].label, "desk");
    assert.equal(body.accounts.items[0].hasRefreshToken, true);
    assert.equal(body.accounts.items[1].healthy, false);
    assert.equal(body.accounts.items[1].lastError, "boom");
    assert.equal(body.accounts.nextLabel, "desk");

    const denied = await fetch(`${base}/console/api/accounts`, { method: "POST", body: "{}" });
    assert.equal(denied.status, 400);
    const modelsWithoutKey = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(modelsWithoutKey.status, 401);
    const modelsWithKey = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer console-test-key", "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(modelsWithKey.status, 400);
    const addedToken = "added-access-token-value-0123456789";
    const addedRefresh = "added-refresh-token-value";
    const created = await fetch(`${base}/console/api/accounts`, {
      method: "POST",
      headers: { authorization: "Bearer console-test-key", "content-type": "application/json" },
      body: JSON.stringify({ label: "extra", accessToken: addedToken, refreshToken: addedRefresh }),
    });
    assert.equal(created.status, 200);
    const after = await fetch(`${base}/console/api/status`, { headers: { "x-api-key": "console-test-key" } });
    const afterBody = await after.json();
    const afterText = JSON.stringify(afterBody);
    assert.equal(afterBody.accounts.total, 3);
    assert.ok(afterBody.accounts.items.some((item: { label: string }) => item.label === "extra"));
    assert.ok(!afterText.includes(addedToken));
    assert.ok(!afterText.includes(addedRefresh));

    const login = await fetch(`${base}/console/api/accounts/login`, {
      method: "POST",
      headers: { authorization: "Bearer console-test-key", "content-type": "application/json" },
      body: JSON.stringify({ label: "web" }),
    });
    assert.equal(login.status, 200);
    const loginBody = await login.json();
    assert.match(loginBody.url, /^https:\/\/www\.cursor\.com\/loginDeepControl\?/);
    assert.equal(loginBody.url.includes("verifier="), false);
    assert.equal(typeof loginBody.id, "string");
    const tick = await fetch(`${base}/console/api/accounts/login/${loginBody.id}`, {
      headers: { authorization: "Bearer console-test-key" },
    });
    assert.equal(tick.status, 200);
    const tickBody = await tick.json();
    assert.ok(["pending", "ready", "error", "expired"].includes(tickBody.status));
    assert.equal(JSON.stringify(tickBody).includes("accessToken"), false);
    assert.equal(JSON.stringify(tickBody).includes("verifier"), false);
    assert.equal(body.config.apiKeyRequired, true);
    assert.equal(body.config.modelPrefix, "cursor-");
    assert.ok(!keysDeep(body).includes("accessToken"));
    assert.ok(!keysDeep(body).includes("refreshToken"));
    assert.ok(!encoded.includes(access));
    assert.ok(!encoded.includes(spare));
    assert.ok(!encoded.includes(refresh));
    assert.ok(!encoded.includes(otherRefresh));

    const escaped = await fetch(`${base}/console/..%2f..%2fpackage.json`);
    const escapedBody = await escaped.text();
    assert.notEqual(escaped.status, 200);
    assert.ok(!escapedBody.includes("AGPL-3.0-only"));

    const dotted = await fetch(`${base}/console/../../package.json`);
    assert.notEqual(dotted.status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    rmSync(dir, { recursive: true, force: true });
  }
});
