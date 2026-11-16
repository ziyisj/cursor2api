/**
 * Account pool and token lifecycle.
 *
 * The auth file is a JSON array so it can be edited by hand and hot-reloaded:
 *
 *   [
 *     { "label": "aq-main", "accessToken": "eyJ...", "refreshToken": "eyJ..." }
 *   ]
 *
 * Access tokens are session JWTs (about two months of life on current accounts).
 * `refreshToken` is exchanged at `POST /auth/exchange_user_api_key` with the refresh
 * token as the bearer, which returns a fresh pair; refreshed pairs are written back
 * to the same file atomically with 0600.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { h2Request } from "./cursor/h2.js";

const REFRESH_BASE = "https://api2.cursor.sh";
const REFRESH_PATH = "/auth/exchange_user_api_key";
/** Refresh this far ahead of expiry. */
const REFRESH_SKEW_MS = 30 * 60 * 1000;

export interface Account {
  label: string;
  accessToken: string;
  refreshToken?: string;
  /** Derived from the JWT when absent. */
  expiresAt?: string;
  /** Set when the account is failing so the pool can skip it. */
  disabledUntil?: string;
  lastError?: string;
  /** false parks the account until the operator enables it again. */
  schedulable?: boolean;
  /** Successful chat turns. */
  requestCount?: number;
  lastUsedAt?: string;
}

/**
 * Account-scoped upstream failures. The current request is retried on the next
 * healthy account, and this one stays out of rotation for the returned duration.
 * Anything else is a property of the request, not the account.
 */
export function failoverCooldownMs(code: string | undefined): number | null {
  switch (code) {
    case "resource_exhausted":
      return 5 * 60_000;
    case "unauthenticated":
      return 2 * 60_000;
    case "permission_denied":
      return 10 * 60_000;
    case "unavailable":
      return 30_000;
    default:
      return null;
  }
}

/** Safe account row for the browser console. Token fields are intentionally absent. */
export interface AccountView {
  label: string;
  healthy: boolean;
  schedulable: boolean;
  expiresAt: string | null;
  disabledUntil: string | null;
  lastError: string | null;
  hasRefreshToken: boolean;
  requestCount: number;
  lastUsedAt: string | null;
}

export class AccountPool {
  private accounts: Account[] = [];
  private cursor = 0;
  private mtimeMs = 0;

  constructor(
    private readonly file: string,
    private readonly log: (msg: string) => void,
    /** Same SOCKS5 egress as the RPC calls, so refreshes leave from the same exit. */
    private readonly proxyUrl?: string | undefined,
  ) {
    this.reload();
  }

  reload(): void {
    if (!existsSync(this.file)) {
      if (this.accounts.length > 0 || this.mtimeMs === 0) this.log(`auth file not found: ${this.file}`);
      this.accounts = [];
      this.mtimeMs = -1;
      return;
    }
    const st = statSync(this.file);
    if (st.mtimeMs === this.mtimeMs && this.accounts.length > 0) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Account[] | { accounts?: Account[] };
    const list = Array.isArray(parsed) ? parsed : (parsed.accounts ?? []);
    this.accounts = list
      .filter((a) => typeof a?.accessToken === "string" && a.accessToken.length > 0)
      .map((a, i) => ({ ...a, label: a.label || `account-${i + 1}` }));
    this.mtimeMs = st.mtimeMs;
    this.log(`loaded ${this.accounts.length} cursor account(s) from ${this.file}`);
  }

  /** Healthy account count. */
  size(): number {
    this.reload();
    return this.accounts.filter((a) => !isDisabled(a)).length;
  }

  labels(): string[] {
    return this.accounts.map((a) => a.label);
  }

  /**
   * Metadata for the console. Reloads the auth file first. The returned objects
   * are built field-by-field so a token can never ride along on a spread.
   */
  inspect(): { total: number; healthy: number; nextLabel: string | null; items: AccountView[] } {
    this.reload();
    const healthy = this.healthyAccounts();
    const items = this.accounts.map((account) => this.toView(account));
    return {
      total: items.length,
      healthy: healthy.length,
      nextLabel: healthy.length > 0 ? healthy[this.cursor % healthy.length]!.label : null,
      items,
    };
  }

  /** Next healthy account in rotation. Does not advance the cursor. */
  async peek(): Promise<Account> {
    this.reload();
    const healthy = this.healthyAccounts();
    if (healthy.length === 0) throw new Error(this.emptyReason());
    return this.ensureFresh(healthy[this.cursor % healthy.length]!);
  }

  /**
   * Round-robin over accounts that are schedulable and not cooling down.
   * The cursor advances before the refresh await, so overlapping requests
   * still land on different accounts.
   */
  async next(): Promise<Account> {
    this.reload();
    const healthy = this.healthyAccounts();
    if (healthy.length === 0) throw new Error(this.emptyReason());
    const account = healthy[this.cursor % healthy.length]!;
    this.cursor = (this.cursor + 1) % healthy.length;
    return this.ensureFresh(account);
  }

  /**
   * Insert a token pair. `replace` updates an existing label in place — used when
   * the same Cursor login is approved again — and puts that account back in rotation.
   */
  add(input: { label: string; accessToken: string; refreshToken?: string }, replace = false): { label: string; replaced: boolean } {
    this.reload();
    const label = input.label.trim();
    if (!validLabel(label)) throw new Error("账号标签只能用 1–64 位、不能含空格或 / \\");
    const accessToken = input.accessToken.trim();
    if (accessToken.length < 20 || accessToken.length > 20_000) throw new Error("access token 长度不对");
    const refresh = input.refreshToken?.trim();
    if (refresh && refresh.length > 20_000) throw new Error("refresh token 长度不对");
    const expiry = jwtExpiryMs(accessToken);
    const existing = this.accounts.find((account) => account.label === label);
    if (existing) {
      if (!replace) throw new Error("这个标签已经在池子里");
      existing.accessToken = accessToken;
      if (refresh) existing.refreshToken = refresh;
      if (expiry) existing.expiresAt = new Date(expiry).toISOString();
      existing.schedulable = true;
      delete existing.disabledUntil;
      delete existing.lastError;
      this.persist();
      this.log(`updated account ${label}`);
      return { label, replaced: true };
    }
    const account: Account = {
      label,
      accessToken,
      schedulable: true,
      requestCount: 0,
      ...(refresh ? { refreshToken: refresh } : {}),
      ...(expiry ? { expiresAt: new Date(expiry).toISOString() } : {}),
    };
    this.accounts.push(account);
    this.persist();
    this.log(`added account ${label}`);
    return { label, replaced: false };
  }

  remove(label: string): void {
    this.reload();
    const next = this.accounts.filter((account) => account.label !== label);
    if (next.length === this.accounts.length) throw new Error("account not found");
    this.accounts = next;
    this.persist();
    this.log(`removed account ${label}`);
  }

  /** Enabling an account also clears a cooldown, so it rejoins the rotation immediately. */
  setSchedulable(label: string, schedulable: boolean): void {
    const target = this.find(label);
    target.schedulable = schedulable;
    if (schedulable) {
      delete target.disabledUntil;
      delete target.lastError;
    }
    this.persist();
  }

  clearCooldown(label: string): void {
    const target = this.find(label);
    delete target.disabledUntil;
    delete target.lastError;
    this.persist();
  }

  markFailure(account: Account, error: string, cooldownMs = 60_000): void {
    const target = this.accounts.find((a) => a.label === account.label);
    if (!target) return;
    target.lastError = error;
    target.disabledUntil = new Date(Date.now() + cooldownMs).toISOString();
    this.persist();
    this.log(`account ${account.label} cooling down ${Math.round(cooldownMs / 1000)}s: ${error}`);
  }

  /** A finished chat turn. Clears a cooldown and counts the request. */
  noteUse(account: Account): void {
    const target = this.accounts.find((a) => a.label === account.label);
    if (!target) return;
    delete target.disabledUntil;
    delete target.lastError;
    target.requestCount = (target.requestCount ?? 0) + 1;
    target.lastUsedAt = new Date().toISOString();
    this.persist();
  }

  private async ensureFresh(account: Account): Promise<Account> {
    const expiry = account.expiresAt ? Date.parse(account.expiresAt) : jwtExpiryMs(account.accessToken);
    if (expiry && expiry - Date.now() > REFRESH_SKEW_MS) return account;
    // Without a refresh token there is nothing to do; let the request run and
    // surface the real upstream error rather than guessing here.
    if (!account.refreshToken) return account;
    try {
      const refreshed = await exchangeRefreshToken(account.refreshToken, this.proxyUrl);
      account.accessToken = refreshed.accessToken;
      if (refreshed.refreshToken) account.refreshToken = refreshed.refreshToken;
      account.expiresAt = new Date(
        jwtExpiryMs(refreshed.accessToken) ?? Date.now() + 55 * 60 * 1000,
      ).toISOString();
      this.persist();
      this.log(`refreshed ${account.label}, expires ${account.expiresAt}`);
    } catch (err) {
      this.log(`token refresh failed for ${account.label}: ${(err as Error).message}`);
    }
    return account;
  }

  private healthyAccounts(): Account[] {
    return this.accounts.filter((account) => !isDisabled(account));
  }

  private emptyReason(): string {
    if (this.accounts.length === 0) return "no cursor account configured";
    if (this.accounts.every((account) => account.schedulable === false)) return "all cursor accounts are paused";
    return "all cursor accounts are in cooldown";
  }

  private find(label: string): Account {
    this.reload();
    const target = this.accounts.find((account) => account.label === label);
    if (!target) throw new Error("account not found");
    return target;
  }

  private toView(account: Account): AccountView {
    const jwtExp = jwtExpiryMs(account.accessToken);
    return {
      label: account.label,
      healthy: !isDisabled(account),
      schedulable: account.schedulable !== false,
      expiresAt: account.expiresAt ?? (jwtExp ? new Date(jwtExp).toISOString() : null),
      disabledUntil: account.disabledUntil ?? null,
      lastError: account.lastError ?? null,
      hasRefreshToken: typeof account.refreshToken === "string" && account.refreshToken.length > 0,
      requestCount: account.requestCount ?? 0,
      lastUsedAt: account.lastUsedAt ?? null,
    };
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.accounts, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.mtimeMs = statSync(this.file).mtimeMs;
  }
}

function isDisabled(account: Account): boolean {
  if (account.schedulable === false) return true;
  return account.disabledUntil ? Date.parse(account.disabledUntil) > Date.now() : false;
}

function validLabel(label: string): boolean {
  return label.length >= 1 && label.length <= 64 && !/[\s/\\#?%]/.test(label) && label !== "." && label !== "..";
}

export async function exchangeRefreshToken(
  refresh: string,
  proxyUrl?: string | undefined,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const res = await h2Request({
    baseUrl: REFRESH_BASE,
    path: REFRESH_PATH,
    proxyUrl,
    body: Buffer.from("{}", "utf8"),
    headers: {
      ":method": "POST",
      authorization: `Bearer ${refresh}`,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`refresh HTTP ${res.status}`);
  const data = JSON.parse(res.body.toString("utf8")) as { accessToken?: string; refreshToken?: string };
  if (!data.accessToken) throw new Error("refresh response carried no accessToken");
  return { accessToken: data.accessToken, refreshToken: data.refreshToken };
}

export function jwtExpiryMs(jwt: string): number | undefined {
  const part = jwt.split(".")[1];
  if (!part) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { exp?: number };
    return typeof claims.exp === "number" ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}
