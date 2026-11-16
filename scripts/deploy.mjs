/**
 * One-step start for this repository.
 *
 *   node scripts/deploy.mjs          ask, default is this computer only
 *   node scripts/deploy.mjs local    listen on 127.0.0.1
 *   node scripts/deploy.mjs public   listen on 0.0.0.0 and require an API key
 *
 * Windows: double-click deploy.cmd. Linux: bash deploy.sh
 */
import { spawn, execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const port = positivePort(process.env.CURSOR_DIRECT_PORT) ?? 8790;

const mode = await chooseMode();
const saved = readEnv(envFile);
const apiKey = mode === "public" ? ensureApiKey(saved) : saved.get("CURSOR_DIRECT_API_KEY") || "";
const host = mode === "public" ? "0.0.0.0" : "127.0.0.1";

upsertEnv(envFile, "CURSOR_DIRECT_HOST", host);
upsertEnv(envFile, "CURSOR_DIRECT_PORT", String(port));
if (mode === "public") upsertEnv(envFile, "CURSOR_DIRECT_API_KEY", apiKey);

if (!(await npmReady())) {
  console.log("正在安装依赖…");
  const code = await run(npmCommand(), ["install", "--no-audit", "--no-fund"], { cwd: root });
  if (code !== 0) {
    console.error("npm install 失败。需要 Node.js 20 或更新版本，并且 node 旁边要有 npm。");
    process.exit(code || 1);
  }
}

if (await healthOk()) {
  console.log(`服务已经在端口 ${port} 上运行。`);
  printUrls();
  if (mode === "local") openBrowser(`http://127.0.0.1:${port}/console`);
  process.exit(0);
}

if (mode === "public") {
  const opened = await allowWindowsPort(port);
  console.log(opened ? `已放行 Windows 防火墙 TCP ${port}。` : `如果外面打不开，请放行 TCP ${port}。云服务器还要在安全组放行这个端口。`);
}

printUrls();
console.log("关闭这个窗口就会停止服务。");
waitAndOpen(`http://127.0.0.1:${port}/console`);

const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const child = spawn(process.execPath, [tsx, "src/index.ts"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    ...Object.fromEntries(readEnv(envFile)),
    CURSOR_DIRECT_HOST: host,
    CURSOR_DIRECT_PORT: String(port),
    CURSOR_DIRECT_PROTO_DIR: path.join(root, "proto"),
    CURSOR_DIRECT_WEB_DIR: path.join(root, "web"),
    ...(apiKey ? { CURSOR_DIRECT_API_KEY: apiKey } : {}),
  },
});
child.on("exit", (code) => process.exit(code ?? 0));

async function chooseMode() {
  const arg = (process.argv[2] || "").toLowerCase();
  if (arg === "local" || arg === "1") return "local";
  if (arg === "public" || arg === "2") return "public";
  if (!process.stdin.isTTY) return "local";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question("1 = 只在这台电脑打开\n2 = 允许局域网和外网访问\n请选择 [1]: ", resolve);
  });
  rl.close();
  return answer.trim() === "2" ? "public" : "local";
}

function ensureApiKey(saved) {
  const existing = saved.get("CURSOR_DIRECT_API_KEY");
  if (existing) {
    console.log("外网模式使用 .env 里已有的 API Key。");
    return existing;
  }
  const created = `c2a_${randomBytes(24).toString("base64url")}`;
  console.log("已生成 API Key，并写入 .env。控制台和接口都要用它：");
  console.log(created);
  return created;
}

function printUrls() {
  const local = `http://127.0.0.1:${port}/console`;
  console.log(`控制台  ${local}`);
  if (mode !== "public") return;
  for (const address of lanAddresses()) console.log(`外网/局域网  http://${address}:${port}/console`);
  console.log("调用接口时带上请求头 Authorization: Bearer <API Key>。");
}

function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      found.push(entry.address);
    }
  }
  return found;
}

function positivePort(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

function readEnv(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    map.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
  }
  return map;
}

function upsertEnv(file, key, value) {
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  const prefix = `${key}=`;
  let found = false;
  const next = lines.map((line) => {
    if (line.startsWith(prefix)) {
      found = true;
      return prefix + value;
    }
    return line;
  });
  if (!found) next.push(prefix + value);
  while (next.length > 0 && next[next.length - 1] === "") next.pop();
  writeFileSync(file, `${next.join("\n")}\n`);
}

function npmReady() {
  return existsSync(path.join(root, "node_modules", "tsx", "dist", "cli.mjs"));
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

function healthOk() {
  return fetch(`http://127.0.0.1:${port}/health`)
    .then((res) => res.ok)
    .catch(() => false);
}

function waitAndOpen(url) {
  const timer = setInterval(() => {
    healthOk().then((ok) => {
      if (!ok) return;
      clearInterval(timer);
      openBrowser(url);
    });
  }, 500);
  setTimeout(() => clearInterval(timer), 20_000).unref?.();
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
}

function allowWindowsPort(targetPort) {
  if (process.platform !== "win32") return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      "netsh",
      [
        "advfirewall",
        "firewall",
        "add",
        "rule",
        `name=cursor2api-${targetPort}`,
        "dir=in",
        "action=allow",
        "protocol=TCP",
        `localport=${targetPort}`,
      ],
      (err) => resolve(!err),
    );
  });
}
