/**
 * Model catalogue.
 *
 * Two upstream lists are joined. `GetUsableModels` is every slug the agent
 * endpoint will accept, including effort and speed variants the account has not
 * turned on. `AvailableModels` says which of those the account can actually
 * pick: hidden, disabled, chat-only, and switched-off models are dropped, and
 * so are variants that exist only with Max mode on. This service never sets
 * max mode, so those slugs fail if advertised.
 *
 * Client-visible names carry the configured prefix, with one wrinkle: a handful
 * of upstream ids already start with `cursor-` (`cursor-grok-4.6-high`), so
 * prefixing must not double up.
 */
import protobuf from "protobufjs";
import path from "node:path";
import type { Config } from "./config.js";
import { protoDir } from "./cursor/proto.js";
import { runTurn } from "./cursor/session.js";
import { unaryCall } from "./cursor/unary.js";

const agentRoot = protobuf.loadSync(path.join(protoDir, "agent.proto"));
const GetUsableModelsRequest = agentRoot.lookupType("agent.v1.GetUsableModelsRequest");
const GetUsableModelsResponse = agentRoot.lookupType("agent.v1.GetUsableModelsResponse");
const availableRoot = protobuf.loadSync(path.join(protoDir, "available.proto"));
const AvailableModelsRequest = availableRoot.lookupType("aiserver.v1.AvailableModelsRequest");
const AvailableModelsResponse = availableRoot.lookupType("aiserver.v1.AvailableModelsResponse");

/** Cursor's DegradationStatus.DISABLED. */
const DEGRADATION_DISABLED = 2;
/** aiserver.v1.AvailableModelsResponse.ModelVendorId.CURSOR. Grok is served under this vendor. */
const CURSOR_VENDOR = 6;

/** Used until the first successful upstream fetch, and if the RPC ever fails. */
export const FALLBACK_MODEL_IDS = [
  "auto",
  "claude-opus-5-thinking-high",
  "claude-sonnet-5-thinking-high",
  "claude-fable-5-thinking-high",
  "claude-opus-4-8-thinking-high",
  "composer-2.5",
  "gpt-5.6-sol-high",
  "gpt-5.6-luna-high",
  "gpt-5.3-codex",
  "gpt-5.2",
  "cursor-grok-4.6-high",
  "gemini-3.7-flash-high",
];

const CACHE_TTL_MS = 10 * 60 * 1000;

let cache: { ids: string[]; at: number } | null = null;

export function clientName(upstreamId: string, prefix: string): string {
  if (!prefix) return upstreamId;
  return upstreamId.startsWith(prefix) ? upstreamId : `${prefix}${upstreamId}`;
}

/**
 * Resolve a client-visible model name back to an upstream id. Falls back to the
 * name as given so a caller can always address a model the catalogue hasn't seen.
 */
export function upstreamId(name: string, prefix: string, known: readonly string[]): string {
  const trimmed = name.trim();
  if (known.includes(trimmed)) return trimmed;
  if (prefix && trimmed.startsWith(prefix)) {
    const stripped = trimmed.slice(prefix.length);
    if (known.includes(stripped)) return stripped;
    // Unknown to the catalogue: prefer the stripped form, since that is what a
    // prefixed client name means, unless stripping empties it.
    if (stripped) return stripped;
  }
  return trimmed;
}

export interface CatalogVariant {
  legacySlug?: string;
  isMaxMode?: boolean;
}

export interface CatalogModel {
  name?: string;
  defaultOn?: boolean;
  isHidden?: boolean;
  isChatOnly?: boolean;
  supportsAgent?: boolean;
  onlySupportsCmdK?: boolean;
  degradationStatus?: number;
  vendor?: { id?: number; displayName?: string };
  variants?: CatalogVariant[];
}

/**
 * Keep slugs the account has switched on and this service can call.
 *
 * A missing catalogue means the availability call failed, so the usable list is
 * returned unchanged. An empty catalogue is the same: there is nothing to
 * filter against.
 */
export function selectCallableModelIds(
  usableIds: readonly string[],
  catalog: readonly CatalogModel[] | null,
  options?: { allowThirdParty?: boolean },
): string[] {
  const allowThirdParty = options?.allowThirdParty !== false;
  const seen = new Set<string>();
  const unique = usableIds.filter((id) => {
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  if (!catalog || catalog.length === 0) return unique;

  const callable = new Set<string>();
  for (const model of catalog) {
    if (!modelIsOn(model)) continue;
    if (!allowThirdParty && !includedWithoutCredits(model)) continue;
    const variants = model.variants ?? [];
    let keptVariant = false;
    for (const variant of variants) {
      const slug = variant.legacySlug?.trim();
      if (!slug || variant.isMaxMode === true) continue;
      callable.add(slug);
      keptVariant = true;
    }
    if (!keptVariant && model.name) callable.add(model.name);
  }
  const selected = unique.filter((id) => callable.has(id));
  if (selected.length > 0) return selected;
  return allowThirdParty ? unique : [];
}

/** Cursor's own models are inside the weekly allowance. Other vendors need credits. */
function includedWithoutCredits(model: CatalogModel): boolean {
  if (model.vendor?.id === CURSOR_VENDOR) return true;
  const name = (model.name || "").toLowerCase();
  return name === "default" || name === "auto";
}

function thirdPartySample(usableIds: readonly string[], catalog: readonly CatalogModel[]): string | null {
  const thirdParty = new Set<string>();
  for (const model of catalog) {
    if (!modelIsOn(model) || includedWithoutCredits(model)) continue;
    for (const variant of model.variants ?? []) {
      const slug = variant.legacySlug?.trim();
      if (slug && variant.isMaxMode !== true) thirdParty.add(slug);
    }
  }
  return usableIds.find((id) => thirdParty.has(id)) ?? null;
}

function modelIsOn(model: CatalogModel): boolean {
  if (model.isHidden === true) return false;
  if (model.degradationStatus === DEGRADATION_DISABLED) return false;
  if (model.supportsAgent === false) return false;
  if (model.isChatOnly === true) return false;
  if (model.onlySupportsCmdK === true) return false;
  return model.defaultOn === true;
}

async function fetchUsableIds(token: string, config: Config): Promise<string[]> {
  const body = GetUsableModelsRequest.encode(GetUsableModelsRequest.create({})).finish();
  const res = await unaryCall("/agent.v1.AgentService/GetUsableModels", body, token, config);
  if (!res.payload) return [];
  const decoded = GetUsableModelsResponse.toObject(GetUsableModelsResponse.decode(res.payload), {
    defaults: false,
    enums: String,
    longs: Number,
  }) as { models?: Array<{ modelId?: string }> };
  return (decoded.models ?? [])
    .map((model) => model.modelId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

async function fetchCatalog(token: string, config: Config): Promise<CatalogModel[] | null> {
  try {
    const body = AvailableModelsRequest.encode(
      AvailableModelsRequest.create({ useModelParameters: true, includeHiddenModels: true }),
    ).finish();
    const res = await unaryCall("/aiserver.v1.AiService/AvailableModels", body, token, config);
    if (!res.payload) return null;
    const decoded = AvailableModelsResponse.toObject(AvailableModelsResponse.decode(res.payload), {
      defaults: false,
      longs: Number,
    }) as { models?: CatalogModel[] };
    return decoded.models ?? [];
  } catch {
    return null;
  }
}

/**
 * One third-party slug is enough: Cursor rejects the whole vendor class with
 * the same weekly-usage error. `null` means the check itself failed.
 */
async function thirdPartyIncluded(token: string, config: Config, model: string): Promise<boolean | null> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12_000);
  try {
    for await (const ev of runTurn({
      token,
      model,
      rootMessages: [],
      userText: "ok",
      tools: [],
      config,
      signal: abort.signal,
    })) {
      if (ev.type === "text" || ev.type === "thinking") return true;
      if (ev.type === "done") {
        if (ev.code === "model_not_included") return false;
        return ev.reason === "error" ? null : true;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function listModelIds(token: string, config: Config): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.ids;
  try {
    const [usable, catalog] = await Promise.all([fetchUsableIds(token, config), fetchCatalog(token, config)]);
    if (usable.length > 0) {
      let allowThirdParty = true;
      const sample = catalog ? thirdPartySample(usable, catalog) : null;
      if (sample) {
        const included = await thirdPartyIncluded(token, config, sample);
        if (included === false) allowThirdParty = false;
      }
      const ids = selectCallableModelIds(usable, catalog, { allowThirdParty });
      if (ids.length > 0) {
        cache = { ids, at: Date.now() };
        return ids;
      }
    }
  } catch {
    /* fall through to the static list */
  }
  const ids = cache?.ids ?? FALLBACK_MODEL_IDS;
  cache = { ids, at: Date.now() };
  return ids;
}

export interface OpenAIModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export function toModelList(ids: readonly string[], prefix: string): OpenAIModelEntry[] {
  const created = Math.floor(Date.now() / 1000);
  const seen = new Set<string>();
  const out: OpenAIModelEntry[] = [];
  for (const id of ids) {
    const name = clientName(id, prefix);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: name, object: "model", created, owned_by: "cursor" });
  }
  return out;
}
