# alysis2api

A Cloudflare Worker that fronts the **Alysis Code Pro** gateway so the Alysis CLI
(and anything else that speaks OpenAI-compatible `/v1/chat/completions`) can use
Alysis' hosted free-credit models through a stable endpoint with its own key.

- Gateway: `https://<project>.supabase.co/functions/v1/llm/v1`
- Deployed: `https://<your-worker>.workers.dev`

## What the gateway actually does (probed 2026-10-09)

Three facts drive the whole design. All were verified against the live gateway,
not read from docs:

**1. `/v1/models` is public.** It answers `200` with the full allowlist even with
no `Authorization` header (and with a bogus one). So it leaks nothing about the
key, but it also means `/models` cannot be used to validate a client key.

**2. The gateway pins one wire protocol per model family.** There is no single
endpoint that serves everything:

| model            | required path            | note                                    |
| ---------------- | ------------------------ | -------------------------------------- |
| `deepseek-flash` | `/v1/chat/completions`   | plain OpenAI, no translation needed     |
| `glm-5.3-flash`   | `/v1/chat/completions`   | plain OpenAI, no translation needed     |
| `gpt-6-luna`      | `/v1/responses`          | 400 on `/chat/completions`              |
| `claude-haiku-5-5`| `/v1/messages`           | 400 on `/chat/completions`              |

Sending `gpt-6-luna` to `/chat/completions` returns:
`{"error":{"message":"Luna uses /v1/responses for reasoning and tools.", ...}}`
with HTTP 400. Sending `claude-haiku-5-5` to `/chat/completions` returns
`"Sonnet uses /v1/messages for reasoning and tools."`

**3. The CLI does not switch protocols for a custom `base_url`.** Protocol
selection lives in `llm/factory.py → resolve_model_protocol()`:

```python
def resolve_model_protocol(*, provider_key, model, protocol):
    if provider_key == "alysis" and model == "gpt-6-luna":
        return OPENAI_RESPONSES_PROTOCOL
    if provider_key == "alysis" and model in {"claude-sonnet-5-5", "claude-haiku-5-5"}:
        return ANTHROPIC_MESSAGES_PROTOCOL
    return protocol
```

That only fires when `provider_key == "alysis"`, which only the built-in hosted
preset has. A custom profile keeps `protocol="openai_compat"` no matter which
model you pick — verified by capturing the CLI's actual HTTP traffic with a
local mock server, where `--model gpt-6-luna` against a custom base URL still
hit `/v1/chat/completions`.

This is the crux: **a custom profile is stuck on `/chat/completions`.** So if
you want luna or haiku through the CLI at all, the translation has to live here.

## Status

**Live and verified end-to-end:** `deepseek-flash` and `glm-5.3-flash` pass
through on `/v1/chat/completions`. The Alysis CLI completed a full agent loop
through this worker (read a file with `fs_read`, parsed it, answered correctly),
including the streaming tool-call cycle.

`gpt-6-luna` and `claude-haiku-5-5` are bridged (v1.1.0): the Worker translates
chat/completions ⇄ `/responses` and `/messages`, including streaming and tool calls.

| model             | upstream route | worker status                    |
| ----------------- | -------------- | -------------------------------- |
| `deepseek-flash`  | `/chat/completions` | enabled, pass-through       |
| `glm-5.3-flash`   | `/chat/completions` | enabled, pass-through       |
| `gpt-6-luna`      | `/responses`   | bridged (chat ⇄ responses)      |
| `claude-haiku-5-5`| `/messages`    | bridged (chat ⇄ messages)       |

## The bug that cost the most time

A forwarding proxy sends `body: JSON.stringify(obj)`. This gateway rejects the
object form with:

```
400 {"error":{"message":"Invalid hosted JSON request. Send a UTF-8 JSON object."}}
```

Confirmed by replaying four request shapes from inside a Worker against the
gateway: `body: <object>` → 400 on every variant (bare, with user-agent, with
accept); `body: JSON.stringify(<object>)` → 200. Direct `curl` with a string
body always worked, so the bug is invisible outside a Worker — it only appears
on the Cloudflare-to-Supabase hop. Keep the explicit `JSON.stringify`.

## Captured wire shapes (reference for the bridges)

**`gpt-6-luna` on `/responses`** — text stream events:
`response.created`, `response.in_progress`, `response.output_item.added`,
`response.output_item.done`, `response.content_part.added`,
`response.output_text.delta`, `response.output_text.done`,
`response.content_part.done`, `response.completed`.

Tool calls come as an output item, not a text delta:

```json
{"type":"response.output_item.added",
 "item":{"id":"fc_…","type":"function_call","status":"in_progress",
         "arguments":"","call_id":"call_…","name":"get_weather"},
 "output_index":0}
{"type":"response.function_call_arguments.delta","delta":"{\"","item_id":"fc_…"}
{"type":"response.function_call_arguments.done","arguments":"{\"city\":\"Tokyo\"}","item_id":"fc_…"}
{"type":"response.output_item.done","item":{…,"status":"completed","arguments":"{\"city\":\"Tokyo\"}"}}
```

Note the tool schema is flat (`{"type":"function","name":…,"parameters":{…}}`),
not nested under `function` like OpenAI chat completions. Arguments arrive as
many small `delta` fragments that must be concatenated by `item_id`.
`call_id` is the OpenAI `tool_call_id` equivalent. Reasoning arrives as a
separate `type:"reasoning"` output item with `encrypted_content`.

**`claude-haiku-5-5` on `/messages`** — captured on retry. The first
~24 attempts (about 2 minutes) returned `429 hosted_capacity_exceeded` with
"No generation was started or credits charged", while `deepseek-flash` and
`glm-5.3-flash` returned 200 in the same window. So that 429 was upstream
capacity for this model, not a request-shape or auth problem. Later attempts
succeeded, and the bridge (chat ⇄ messages) is verified for non-stream text,
stream text, and tool calls.

To pass `claude-haiku-5-5` at all, remember the gateway also rejects it on
`/chat/completions` with `"Sonnet uses /v1/messages for reasoning and tools."`

## Pricing and credit behaviour

From the official `get_public_pricing_catalog` RPC (the same source the pricing
page reads) — free allowance 50 credits, caps 10 per 5h and 25 per 7d,
100 credits = $1.00:

| model | label | multiplier |
| ----- | ----- | ---------- |
| `deepseek-flash` | DeepSeek V4.1 Flash | 1× |
| `glm-5.3-flash` | GLM 5.3 Flash | 1× |
| `gpt-6-luna` | GPT-6 Luna | 2× |
| `claude-haiku-5-5` | Claude Haiku 5.5 | 1×, but **5× above 100K prompt tokens** |

`/v1/models` and that RPC both list exactly 4 models; the worker mirrors
`/models` live rather than hardcoding the list.

## Setup

```bash
# 1. Put your gateway key in the worker secret.
npx wrangler secret put GATEWAY_API_KEY      # value: slk_...

# 2. Pick a client key for the CLI / Hermes.
npx wrangler secret put CLIENT_API_KEY       # value: anything random
```

Neither secret has a placeholder. The worker refuses all model traffic with
HTTP 500 until both are set, so it cannot be accidentally left wide open.

## Point the Alysis CLI at it

The profile must be named so it does NOT collide with the built-in `alysis`
preset, because that preset carries its own protocol switching:

```bash
alysis profile add alysis2api \
  --base-url "https://<your-worker>.workers.dev/v1" \
  --api-key-env ALYSIS2API_KEY \
  --default-model deepseek-flash

export ALYSIS2API_KEY='<your CLIENT_API_KEY value>'
alysis profile use alysis2api
alysis run "Fix the failing tests"
```

For Hermes, add a provider pointing at the same `/v1` with your client key.

## Limits to be aware of

- **Single account, self use only.** Alysis ToS §3 forbids reselling or
  sublicensing hosted-model access or credits, and §2 requires one account per
  person for personal fair use. This worker is a key holder and path translator,
  not a shareable public channel.
- **Free credits refill every 30 days** from your last refill, unused credits
  do not carry over. Rate caps: 10 credits per 5 hours, 25 per 7 days (50 total,
  100 credits = $1 of usage).
- **`/v1/models` needs no key**, so it is not an auth check — `/health` reports
  whether the secrets are configured.

## Files

- `worker.js` — routing, auth gate, the `/chat/completions` pass-through, and
  both protocol bridges (chat ⇄ `/responses`, chat ⇄ `/messages`, including
  streaming and tool calls). Bridges are inlined so the worker is one file.
- `tools/alysis-key/alysis_key.py` — third-party device-login helper from
  zidanefaqih/alysis-key (MIT). Copied unmodified; see `tools/alysis-key/NOTICE.md`.
- `LICENSE` — MIT.

`wrangler.toml` is not committed (it holds the gateway base URL). Create your own
with `name`, `main = "worker.js"`, `compatibility_date`, `compatibility_flags =
["nodejs_compat"]`, and a `[vars] GATEWAY_BASE_URL`.
- `wrangler.toml` — name, compatibility, `GATEWAY_BASE_URL`