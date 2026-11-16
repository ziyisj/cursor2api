import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountPool } from "../src/auth.ts";
import type { Config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { describeUpdate } from "../src/update.ts";

test("update comparison treats an equal revision as current", () => {
  assert.equal(describeUpdate("abc", "abc"), "current");
  assert.equal(describeUpdate("abc", "def"), "available");
  assert.equal(describeUpdate(null, "def"), "unknown");
});

test("a caller key unlocks model routes and stays out of the account list", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cursor2api-settings-"));
  const previousSettings = process.env.CURSOR_DIRECT_SETTINGS_FILE;
  const previousEnv = process.env.CURSOR_DIRECT_ENV_FILE;
  process.env.CURSOR_DIRECT_SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.CURSOR_DIRECT_ENV_FILE = path.join(dir, ".env");
  const authFile = path.join(dir, "accounts.json");
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    apiKey: undefined,
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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const closed = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(closed.status, 401);
    assert.match(await closed.text(), /还没有调用密钥/);

    const accounts = await fetch(`${base}/console/api/status`);
    assert.equal(accounts.status, 200);

    const saved = await fetch(`${base}/console/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "platform-key-1" }),
    });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.apiKeySet, true);
    assert.equal(savedBody.apiKey, "platform-key-1");

    const status = await fetch(`${base}/console/api/status`);
    const statusText = JSON.stringify(await status.json());
    assert.equal(statusText.includes("platform-key-1"), false);

    const rejected = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(rejected.status, 401);
    const accepted = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer platform-key-1", "content-type": "application/json" },
      body: "not-json",
    });
    assert.equal(accepted.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (previousSettings === undefined) delete process.env.CURSOR_DIRECT_SETTINGS_FILE;
    else process.env.CURSOR_DIRECT_SETTINGS_FILE = previousSettings;
    if (previousEnv === undefined) delete process.env.CURSOR_DIRECT_ENV_FILE;
    else process.env.CURSOR_DIRECT_ENV_FILE = previousEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});
