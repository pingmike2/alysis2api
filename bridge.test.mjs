// Unit tests for bridge.js — pure functions, no network, no credits spent.
import assert from "node:assert/strict";
import {
  chatToResponses,
  responsesToChatBody,
  responsesSseToChatSse,
  chatToMessages,
  messagesToChatBody,
  messagesSseToChatSse,
} from "./bridge.js";

let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
    console.log("ok  -", name);
  } catch (e) {
    console.error("FAIL -", name, "\n", e.message);
    process.exitCode = 1;
  }
};

const streamOf = async (sse, transform) => {
  const enc = new TextEncoder();
  const src = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(sse));
      c.close();
    },
  });
  const out = src.pipeThrough(transform);
  let text = "";
  const dec = new TextDecoder();
  for await (const chunk of out) text += dec.decode(chunk);
  return text;
};

const parseFrames = (text) =>
  text
    .split("\n\n")
    .filter((f) => f.startsWith("data:"))
    .map((f) => f.slice(5).trim())
    .filter((d) => d && d !== "[DONE]")
    .map((d) => JSON.parse(d));

// ---------- chat -> responses request ----------
t("responses: system becomes instructions, not an input item", () => {
  const p = chatToResponses(
    { messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] },
    "gpt-6-luna",
  );
  assert.equal(p.instructions, "be brief");
  assert.equal(p.input.length, 1);
  assert.equal(p.input[0].role, "user");
});

t("responses: tools are flattened (name/parameters at top level)", () => {
  const p = chatToResponses(
    {
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: { type: "object" } } }],
    },
    "gpt-6-luna",
  );
  assert.equal(p.tools[0].name, "f");
  assert.equal(p.tools[0].function, undefined);
  assert.deepEqual(p.tools[0].parameters, { type: "object" });
});

t("responses: assistant tool_calls + tool result round-trip", () => {
  const p = chatToResponses(
    {
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "w", arguments: '{"c":"T"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny" },
      ],
    },
    "gpt-6-luna",
  );
  const types = p.input.map((i) => i.type);
  assert.deepEqual(types, ["message", "function_call", "function_call_output"]);
  assert.equal(p.input[1].call_id, "call_1");
  assert.equal(p.input[2].call_id, "call_1");
  assert.equal(p.input[2].output, "sunny");
});

t("responses: max_tokens maps to max_output_tokens", () => {
  const p = chatToResponses({ messages: [], max_tokens: 99 }, "gpt-6-luna");
  assert.equal(p.max_output_tokens, 99);
  assert.equal(p.max_tokens, undefined);
});

// ---------- responses -> chat (non-stream) ----------
t("responses->chat: text message", () => {
  const c = responsesToChatBody(
    {
      model: "gpt-6-luna",
      output: [{ type: "message", content: [{ type: "output_text", text: "alive" }] }],
      usage: { input_tokens: 5, output_tokens: 2 },
    },
    "gpt-6-luna",
  );
  assert.equal(c.choices[0].message.content, "alive");
  assert.equal(c.choices[0].finish_reason, "stop");
  assert.equal(c.usage.total_tokens, 7);
});

t("responses->chat: function_call becomes tool_calls with finish=tool_calls", () => {
  const c = responsesToChatBody(
    {
      output: [{ type: "function_call", call_id: "call_9", name: "get_weather", arguments: '{"city":"Osaka"}' }],
      usage: {},
    },
    "gpt-6-luna",
  );
  assert.equal(c.choices[0].finish_reason, "tool_calls");
  assert.equal(c.choices[0].message.tool_calls[0].id, "call_9");
  assert.equal(c.choices[0].message.tool_calls[0].function.arguments, '{"city":"Osaka"}');
});

// ---------- responses SSE -> chat SSE ----------
t("responses SSE: text stream ends with finish + [DONE]", async () => {
  const sse =
    'event: response.created\ndata: {"type":"response.created","response":{}}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n' +
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":2}}}\n\n';
  const out = await streamOf(sse, responsesSseToChatSse({ model: "gpt-6-luna" }));
  const frames = parseFrames(out);
  const text = frames.map((f) => f.choices[0].delta.content || "").join("");
  assert.equal(text, "Hello");
  assert.equal(frames[0].choices[0].delta.role, "assistant");
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});

t("responses SSE: split tool_call fragments are reassembled by item_id", async () => {
  const sse =
    'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"id":"fc_1","type":"function_call","call_id":"call_A","name":"get_weather"},"output_index":0}\n\n' +
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"ci","item_id":"fc_1"}\n\n' +
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"ty\\":\\"Tokyo\\"}","item_id":"fc_1"}\n\n' +
    'event: response.function_call_arguments.done\ndata: {"type":"response.function_call_arguments.done","arguments":"{\\"city\\":\\"Tokyo\\"}","item_id":"fc_1"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{}}}\n\n';
  const out = await streamOf(sse, responsesSseToChatSse({ model: "gpt-6-luna" }));
  const frames = parseFrames(out);
  const args = frames
    .flatMap((f) => (f.choices[0].delta.tool_calls || []).map((c) => c.function && c.function.arguments || ""))
    .join("");
  assert.equal(args, '{"city":"Tokyo"}');
  const start = frames.find((f) => f.choices[0].delta.tool_calls && f.choices[0].delta.tool_calls[0].id);
  assert.equal(start.choices[0].delta.tool_calls[0].id, "call_A");
  assert.equal(start.choices[0].delta.tool_calls[0].function.name, "get_weather");
  assert.equal(frames.at(-1).choices[0].finish_reason, "tool_calls");
});

t("responses SSE: missing response.completed still terminates with [DONE]", async () => {
  const sse = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"x"}\n\n';
  const out = await streamOf(sse, responsesSseToChatSse({ model: "gpt-6-luna" }));
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});

// ---------- chat -> messages request ----------
t("messages: system goes to top-level system field", () => {
  const p = chatToMessages(
    { messages: [{ role: "system", content: "S" }, { role: "user", content: "hi" }] },
    "claude-haiku-5-5",
  );
  assert.equal(p.system, "S");
  assert.equal(p.messages[0].role, "user");
});

t("messages: max_tokens is always set (required by Anthropic)", () => {
  const p = chatToMessages({ messages: [{ role: "user", content: "x" }] }, "claude-haiku-5-5");
  assert.equal(typeof p.max_tokens, "number");
  assert.ok(p.max_tokens > 0);
});

t("messages: tools use input_schema", () => {
  const p = chatToMessages(
    {
      messages: [{ role: "user", content: "x" }],
      tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
    },
    "claude-haiku-5-5",
  );
  assert.equal(p.tools[0].name, "f");
  assert.deepEqual(p.tools[0].input_schema, { type: "object" });
});

t("messages: consecutive tool results merge into ONE user turn", () => {
  const p = chatToMessages(
    {
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "a", arguments: "{}" } },
            { id: "t2", type: "function", function: { name: "b", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: "t1", content: "r1" },
        { role: "tool", tool_call_id: "t2", content: "r2" },
      ],
    },
    "claude-haiku-5-5",
  );
  const roles = p.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "user"]);
  assert.equal(p.messages[2].content.length, 2);
  assert.equal(p.messages[2].content[0].type, "tool_result");
  assert.equal(p.messages[2].content[0].tool_use_id, "t1");
});

// ---------- messages -> chat ----------
t("messages->chat: tool_use becomes tool_calls with JSON-string arguments", () => {
  const c = messagesToChatBody(
    {
      content: [{ type: "tool_use", id: "tu_1", name: "f", input: { x: 1 } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    "claude-haiku-5-5",
  );
  assert.equal(c.choices[0].finish_reason, "tool_calls");
  assert.equal(c.choices[0].message.tool_calls[0].function.arguments, '{"x":1}');
});

t("messages->chat: max_tokens stop maps to finish=length", () => {
  const c = messagesToChatBody(
    { content: [{ type: "text", text: "cut" }], stop_reason: "max_tokens", usage: {} },
    "claude-haiku-5-5",
  );
  assert.equal(c.choices[0].finish_reason, "length");
});

// ---------- messages SSE -> chat SSE ----------
t("messages SSE: text deltas + message_stop -> [DONE]", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m","model":"claude-haiku-5-5","usage":{}}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":2,"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const out = await streamOf(sse, messagesSseToChatSse({ model: "claude-haiku-5-5" }));
  const frames = parseFrames(out);
  assert.equal(frames.map((f) => f.choices[0].delta.content || "").join(""), "Hi");
  assert.equal(frames.at(-1).choices[0].finish_reason, "stop");
  assert.ok(out.trimEnd().endsWith("data: [DONE]"));
});

t("messages SSE: input_json_delta fragments become tool_call arguments", async () => {
  const sse =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"m"}}\n\n' +
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu_9","name":"get_weather","input":{}}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"ci"}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"ty\\":\\"Kyoto\\"}"}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const out = await streamOf(sse, messagesSseToChatSse({ model: "claude-haiku-5-5" }));
  const frames = parseFrames(out);
  const args = frames
    .flatMap((f) => (f.choices[0].delta.tool_calls || []).map((c) => (c.function && c.function.arguments) || ""))
    .join("");
  assert.equal(args, '{"city":"Kyoto"}');
  const start = frames.find((f) => f.choices[0].delta.tool_calls && f.choices[0].delta.tool_calls[0].id);
  assert.equal(start.choices[0].delta.tool_calls[0].id, "tu_9");
  assert.equal(frames.at(-1).choices[0].finish_reason, "tool_calls");
});

console.log(`\n${passed} passed${process.exitCode ? ", FAILURES above" : ", 0 failed"}`);
