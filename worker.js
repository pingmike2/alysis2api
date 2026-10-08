import {
  chatToResponses,
  chatToMessages,
  responsesToChatBody,
  messagesToChatBody,
  responsesSseToChatSse,
  messagesSseToChatSse,
} from "./bridge.js";

/**
 * alysis2api — Cloudflare Worker that fronts the Alysis Code Pro gateway.
 *
 * The gateway is an OpenAI-compatible Supabase Edge Function that authenticates
 * a long-lived `slk_…` gateway key and meters free credits server-side.
 *
 * Design constraints established by probing the live gateway (2026-10-09):
 *
 *  1. `GET /v1/models` is PUBLIC — it answers 200 with the allowlist even with no
 *     Authorization header. So the client key cannot be derived from /models.
 *  2. The gateway does NOT accept one uniform wire protocol. It pins a route per
 *     model family:
 *       deepseek-flash, glm-5.3-flash → /v1/chat/completions  (pass-through)
 *       gpt-6-luna                    → /v1/responses        (needs a bridge)
 *       claude-haiku-5-5              → /v1/messages         (needs a bridge)
 *     Sending luna or haiku to /chat/completions returns HTTP 400 with
 *     "Luna uses /v1/responses for reasoning and tools." / "Sonnet uses
 *     /v1/messages for reasoning and tools."
 *  3. The Alysis CLI does not switch protocols for a custom base_url. Protocol
 *     selection lives in `llm/factory.py: resolve_model_protocol()`, which only
 *     fires when `provider_key == "alysis"` — i.e. only for the built-in hosted
 *     preset. A custom profile therefore always speaks plain
 *     /v1/chat/completions. This worker is the only place the split can be
 *     handled, and it keeps the client side on one simple protocol.
 *
 * Everything here is single-account, self-use only: the Alysis Terms of Service
 * §3 forbid reselling or sublicensing hosted-model access or credits, and §2
 * requires one account per person. See README.md.
 */

const PROXY_VERSION = "1.1.0";

/** Gateway allowlist. Kept in sync with GET /v1/models; /models proxies live. */
const MODEL_ROUTES = {
  "deepseek-flash": "chat/completions",
  "glm-5.3-flash": "chat/completions",
  "gpt-6-luna": "responses",
  "claude-haiku-5-5": "messages",
};

const DEFAULT_MODELS = ["deepseek-flash", "glm-5.3-flash"];

const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "x-alysis2api-version": PROXY_VERSION,
      ...(init.headers || {}),
    },
  });

function upstreamError(message, status = 400, type = "invalid_request_error") {
  return json(
    { error: { message, type, code: type } },
    { status },
  );
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** Fixed secret used by the Alysis CLI — replaces the real gateway key. */
function checkClientKey(request, env) {
  const expected = env.CLIENT_API_KEY;
  if (!expected) return "CLIENT_API_KEY is not set on this worker.";
  const header = request.headers.get("authorization") || "";
  const got = header.replace(/^Bearer\s+/i, "").trim();
  if (got !== expected) return "invalid client api key";
  return null;
}

function gatewayBase(env) {
  return (env.GATEWAY_BASE_URL || "").replace(/\/+$/, "");
}

/** Mirror the upstream allowlist, optionally tagging which models need a bridge. */
async function handleModels(env) {
  const base = gatewayBase(env);
  if (!base) return upstreamError("GATEWAY_BASE_URL is not set on this worker.", 500, "server_error");
  let models = [];
  try {
    const res = await fetch(`${base}/models`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const payload = await res.json().catch(() => null);
      const list = Array.isArray(payload) ? payload : payload && payload.data;
      if (Array.isArray(list)) {
        models = list
          .map((m) => (typeof m === "string" ? m : m && m.id))
          .filter((id) => typeof id === "string" && id.length > 0);
      }
    }
  } catch {
    /* fall through to the pinned list */
  }
  if (models.length === 0) models = [...DEFAULT_MODELS];
  return json({
    object: "list",
    data: models.map((id) => ({
      id,
      object: "model",
      owned_by: "alysis",
      // Non-standard, additive field: tells callers which ids this worker
      // forwards as-is vs. which ones it translates to a different wire format.
      alysis_route: MODEL_ROUTES[id] || "chat/completions",
    })),
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204 });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" || path === "/") {
      return json({
        ok: true,
        version: PROXY_VERSION,
        upstream: gatewayBase(env) || null,
        gateway_key_configured: Boolean(env.GATEWAY_API_KEY),
        client_key_configured: Boolean(env.CLIENT_API_KEY),
        bridged_models: Object.entries(MODEL_ROUTES)
          .filter(([, route]) => route !== "chat/completions")
          .map(([id]) => id),
      });
    }

    if (path === "/v1/models" || path === "/models") {
      return handleModels(env);
    }

    const authError = checkClientKey(request, env);
    if (authError) {
      return upstreamError(authError, authError.startsWith("invalid") ? 401 : 500, "invalid_api_key");
    }

    const upstreamKey = env.GATEWAY_API_KEY;
    if (!upstreamKey) {
      return upstreamError("GATEWAY_API_KEY is not set on this worker.", 500, "server_error");
    }

    if (request.method !== "POST") {
      return upstreamError(`method ${request.method} is not supported`, 405, "invalid_request_error");
    }

    const body = await readJson(request);
    if (!body) return upstreamError("request body must be JSON");

    const model = String(body.model || "").trim();
    const route = MODEL_ROUTES[model];
    if (!route) {
      return upstreamError(
        `unknown model "${model}". Available: ${Object.keys(MODEL_ROUTES).join(", ")}`,
      );
    }

    // route "responses" (gpt-6-luna) and "messages" (claude-haiku-5-5) are
    // translated here; the client always sees chat/completions shape back.
    const bridged = route === "responses" || route === "messages";
    const upstreamPayload = route === "responses"
      ? chatToResponses(body, model)
      : route === "messages"
        ? chatToMessages(body, model)
        : body;

    // Forward verbatim. Content-length is set by fetch; do not copy hop-by-hop
    // headers or the client's own Authorization.
    const headers = {
      "content-type": "application/json",
      accept: request.headers.get("accept") || "text/event-stream",
      authorization: `Bearer ${upstreamKey}`,
      "user-agent": "alysis-code/0.1.0",
    };
    if (request.headers.get("x-alysis-client")) {
      headers["x-alysis-client"] = request.headers.get("x-alysis-client");
    }

    const upstreamUrl = `${gatewayBase(env)}/${route}`;
    // IMPORTANT: stringify before sending. Passing a plain JS object as `body`
    // makes this gateway answer 400 "Invalid hosted JSON request. Send a UTF-8
    // JSON object." — verified by replaying all four variants from a Worker:
    // object body -> 400, JSON.stringify(body) -> 200. Supabase Edge Function
    // request parsing does not accept the object form over Worker fetch.
    const payload = JSON.stringify(upstreamPayload);
    const init = { method: "POST", headers, body: payload };
    if (body.stream) {
      let res;
      try {
        res = await fetch(upstreamUrl, init);
      } catch (err) {
        return upstreamError(`upstream fetch failed: ${err && err.message}`, 502, "server_error");
      }
      if (!res.ok) {
        return json(await res.text().then((t) => t || "{}").catch(() => "{}"), { status: res.status });
      }
      const streamBody = route === "responses"
        ? res.body.pipeThrough(responsesSseToChatSse({ model }))
        : route === "messages"
          ? res.body.pipeThrough(messagesSseToChatSse({ model }))
          : res.body;
      return new Response(streamBody, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") || "text/event-stream",
          "cache-control": "no-cache",
          "x-alysis2api-version": PROXY_VERSION,
        },
      });
    }

    let res;
    try {
      res = await fetch(upstreamUrl, init);
    } catch (err) {
      return upstreamError(`upstream fetch failed: ${err && err.message}`, 502, "server_error");
    }
    let text = await res.text();
    if (bridged && res.ok) {
      try {
        const data = JSON.parse(text);
        const chat = route === "responses"
          ? responsesToChatBody(data, model)
          : messagesToChatBody(data, model);
        text = JSON.stringify(chat);
      } catch {
        // Leave an unparseable upstream body untouched rather than inventing one.
      }
    }
    const outHeaders = {
      // Preserve the upstream content-type verbatim. Wrapping the body would
      // break OpenAI compatibility for the client.
      "content-type": res.headers.get("content-type") || "application/json",
      "x-alysis2api-version": PROXY_VERSION,
    };
    const retryAfter = res.headers.get("retry-after");
    if (retryAfter) outHeaders["retry-after"] = retryAfter;
    return new Response(text, { status: res.status, headers: outHeaders });
  },
};