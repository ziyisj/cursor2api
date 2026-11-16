/**
 * OpenAI Responses API -> the chat-completions shape this gateway already runs.
 *
 * Codex sends `POST /v1/responses` with `input` items (messages, function calls,
 * and function-call outputs) plus a top-level `instructions` string. The turn
 * runner stays the same; only the envelope changes.
 */
import type { OpenAIChatRequest, OpenAIMessage, OpenAIToolCall } from "./translate.js";

export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: unknown;
  stream?: boolean;
  tools?: unknown;
}

export function responsesToChat(body: ResponsesRequest): OpenAIChatRequest {
  const messages: OpenAIMessage[] = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }
  if (typeof body.input === "string") {
    messages.push({ role: "user", content: body.input });
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) messages.push(...itemMessages(item));
  }
  return {
    model: body.model,
    stream: Boolean(body.stream),
    messages,
    tools: normalizeTools(body.tools),
  };
}

export interface ResponseDraft {
  id: string;
  model: string;
  text: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export function completedResponse(draft: ResponseDraft): Record<string, unknown> {
  const output: unknown[] = [];
  if (draft.reasoning) {
    output.push({
      id: `rs_${draft.id}`,
      type: "reasoning",
      summary: [{ type: "summary_text", text: draft.reasoning }],
    });
  }
  if (draft.text) {
    output.push({
      id: `msg_${draft.id}`,
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: draft.text, annotations: [] }],
    });
  }
  for (const call of draft.toolCalls) {
    output.push({
      id: `fc_${call.id}`,
      type: "function_call",
      status: "completed",
      call_id: call.id,
      name: call.name,
      arguments: call.arguments,
    });
  }
  const inputTokens = draft.usage?.inputTokens ?? 0;
  const outputTokens = draft.usage?.outputTokens ?? 0;
  return {
    id: draft.id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: draft.model,
    output,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
  };
}

function itemMessages(item: unknown): OpenAIMessage[] {
  if (!item || typeof item !== "object") return [];
  const record = item as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : "";

  if (type === "function_call") {
    const call: OpenAIToolCall = {
      id: stringField(record.call_id) || stringField(record.id) || "call_unknown",
      type: "function",
      function: { name: stringField(record.name), arguments: stringField(record.arguments) || "{}" },
    };
    return [{ role: "assistant", content: "", tool_calls: [call] }];
  }

  if (type === "function_call_output") {
    return [
      {
        role: "tool",
        tool_call_id: stringField(record.call_id),
        content: outputText(record.output),
      },
    ];
  }

  const role = stringField(record.role);
  if (role === "system" || role === "developer" || role === "user" || role === "assistant") {
    const content = partText(record.content);
    if (!content) return [];
    return [{ role, content }];
  }
  return [];
}

function partText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      return stringField(record.text) || stringField(record.refusal);
    })
    .filter(Boolean)
    .join("\n");
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  const text = partText(output);
  if (text) return text;
  return output == null ? "" : JSON.stringify(output);
}

function normalizeTools(tools: unknown): OpenAIChatRequest["tools"] {
  if (!Array.isArray(tools)) return [];
  const out: NonNullable<OpenAIChatRequest["tools"]> = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    const nested =
      record.function && typeof record.function === "object" ? (record.function as Record<string, unknown>) : null;
    const name = stringField(record.name) || stringField(nested?.name);
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: stringField(record.description) || stringField(nested?.description),
        parameters: record.parameters ?? nested?.parameters ?? { type: "object", properties: {} },
      },
    });
  }
  return out;
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}
