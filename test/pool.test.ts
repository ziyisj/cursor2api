import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountPool, failoverCooldownMs } from "../src/auth.ts";

function jwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url");
  return `${header}.${body}.sig`;
}

test("round robin parks a failed account and continues on the next", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "cursor2api-pool-"));
  const file = path.join(dir, "accounts.json");
  const later = Math.floor(Date.now() / 1000) + 86_400;
  writeFileSync(
    file,
    JSON.stringify([
      { label: "a", accessToken: jwt(later) },
      { label: "b", accessToken: jwt(later) },
    ]),
  );
  const pool = new AccountPool(file, () => {});
  try {
    assert.equal(failoverCooldownMs("resource_exhausted"), 5 * 60_000);
    assert.equal(failoverCooldownMs("invalid_argument"), null);

    const first = await pool.next();
    const second = await pool.next();
    assert.deepEqual([first.label, second.label], ["a", "b"]);

    pool.markFailure(first, "quota", failoverCooldownMs("resource_exhausted") ?? 60_000);
    assert.equal((await pool.next()).label, "b");
    assert.equal((await pool.next()).label, "b");
    assert.equal(pool.inspect().nextLabel, "b");
    assert.equal(pool.inspect().items.find((item) => item.label === "a")?.healthy, false);

    pool.clearCooldown("a");
    assert.deepEqual([(await pool.next()).label, (await pool.next()).label], ["a", "b"]);

    pool.setSchedulable("b", false);
    assert.equal((await pool.next()).label, "a");
    assert.equal(pool.inspect().items.find((item) => item.label === "b")?.schedulable, false);

    pool.noteUse(first);
    assert.equal(pool.inspect().items.find((item) => item.label === "a")?.requestCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
