import assert from "node:assert/strict";
import test from "node:test";
import { explainUpstreamError } from "../src/cursor/session.ts";
import { selectCallableModelIds, type CatalogModel } from "../src/models.ts";

const on = (name: string, variants: CatalogModel["variants"]): CatalogModel => ({
  name,
  defaultOn: true,
  supportsAgent: true,
  variants,
});

test("model list keeps switched-on slugs and drops the ones this service cannot call", () => {
  const usable = [
    "default",
    "claude-opus-5-5-high",
    "claude-opus-5-5-high-fast",
    "claude-opus-5-high",
    "gpt-4o",
    "cmdk",
    "chat",
    "gone",
    "composer-2.5",
    "composer-2.5",
  ];
  const catalog: CatalogModel[] = [
    on("default", [{ legacySlug: "default", isMaxMode: false }]),
    on("claude-opus-5-5", [
      { legacySlug: "claude-opus-5-5-high", isMaxMode: false },
      { legacySlug: "claude-opus-5-5-high-fast", isMaxMode: true },
    ]),
    { name: "claude-opus-5", defaultOn: false, supportsAgent: true, variants: [{ legacySlug: "claude-opus-5-high" }] },
    { name: "gpt-4o", defaultOn: true, supportsAgent: true, isHidden: true, variants: [{ legacySlug: "gpt-4o" }] },
    { name: "cmdk", defaultOn: true, supportsAgent: true, onlySupportsCmdK: true, variants: [{ legacySlug: "cmdk" }] },
    { name: "chat", defaultOn: true, supportsAgent: false, isChatOnly: true, variants: [{ legacySlug: "chat" }] },
    { name: "gone", defaultOn: true, supportsAgent: true, degradationStatus: 2, variants: [{ legacySlug: "gone" }] },
    on("composer-2.5", [
      { legacySlug: "composer-2.5", isMaxMode: false },
      { legacySlug: "composer-2.5-fast", isMaxMode: false },
    ]),
  ];

  assert.deepEqual(selectCallableModelIds(usable, catalog), [
    "default",
    "claude-opus-5-5-high",
    "composer-2.5",
  ]);
});

test("a slug that also has a non-max variant stays", () => {
  const catalog: CatalogModel[] = [
    on("claude-opus-5", [
      { legacySlug: "claude-opus-5-low", isMaxMode: false },
      { legacySlug: "claude-opus-5-low", isMaxMode: true },
    ]),
  ];
  assert.deepEqual(selectCallableModelIds(["claude-opus-5-low"], catalog), ["claude-opus-5-low"]);
});

test("third-party vendors drop when the account has no credits for them", () => {
  const usable = ["default", "grok-4.7-low", "claude-opus-5-5-low", "gpt-5.6-sol-low"];
  const catalog: CatalogModel[] = [
    on("default", [{ legacySlug: "default" }]),
    { ...on("grok-4.7", [{ legacySlug: "grok-4.7-low" }]), vendor: { id: 6, displayName: "Cursor" } },
    { ...on("claude-opus-5-5", [{ legacySlug: "claude-opus-5-5-low" }]), vendor: { id: 1, displayName: "Anthropic" } },
    { ...on("gpt-5.6-sol", [{ legacySlug: "gpt-5.6-sol-low" }]), vendor: { id: 2, displayName: "OpenAI" } },
  ];
  assert.deepEqual(selectCallableModelIds(usable, catalog, { allowThirdParty: false }), ["default", "grok-4.7-low"]);
  assert.deepEqual(selectCallableModelIds(usable, catalog), usable);
});

test("a weekly-usage rejection names the model and does not look like an account outage", () => {
  const explained = explainUpstreamError({
    code: "resource_exhausted",
    message: "Error",
    details: [
      {
        debug: {
          error: "ERROR_USAGE_PRICING_REQUIRED",
          details: {
            title: "Claude Opus 5.5 is not included in your weekly usage",
            detail: "Buy credits or switch to a Grok model to continue.",
            additionalInfo: { unifiedSkuLimitKind: "third_party_model" },
          },
        },
      },
    ],
  });
  assert.equal(explained.code, "model_not_included");
  assert.match(explained.message, /Claude Opus 5\.5/);
  assert.equal(explained.message.includes("resource_exhausted"), false);
});

test("without a catalogue the usable list is kept", () => {
  assert.deepEqual(selectCallableModelIds(["a", "a", "b"], null), ["a", "b"]);
  assert.deepEqual(selectCallableModelIds(["a"], []), ["a"]);
});
