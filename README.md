# unbrewed-agent

External LLM player for Unbrewed Pro.

Goal: let Hermes join an Unbrewed lobby through the same public WebSocket protocol a human client uses, receive only redacted player views and enumerated legal actions, then choose actions via Hermes-managed LLM calls.

The engine stays authoritative. The agent is only a policy client.

## Current MVP

This repo now contains a TypeScript CLI that can connect to the Unbrewed Pro WebSocket server as a normal external seat.

```sh
npm install
npm test
npm run typecheck

# Create a room against a built-in server bot and call ChatGPT Codex directly
# using Hermes' stored openai-codex OAuth subscription.
npx tsx src/cli.ts create-bot \
  --ws-url ws://127.0.0.1:8787 \
  --hero-id king-taranis \
  --bot easy \
  --policy codex-direct \
  --codex-model gpt-5.5 \
  --max-actions 1

# Join an existing lobby as the external player with direct Codex calls.
npx tsx src/cli.ts join \
  --ws-url wss://unbrewed-engine-production.up.railway.app \
  --room-id ROOM \
  --hero-id king-taranis \
  --policy codex-direct \
  --codex-model gpt-5.5 \
  --timeout-ms 45000

# Hermes API-server mode still works, but it is slower because it runs
# through a full Hermes agent turn.
export HERMES_API_KEY=$(grep '^API_SERVER_KEY=' ~/.hermes/profiles/unbrewed-player/.env | cut -d= -f2-)
npx tsx src/cli.ts join \
  --ws-url wss://unbrewed-engine-production.up.railway.app \
  --room-id ROOM \
  --hero-id king-taranis \
  --policy hermes \
  --hermes-url http://127.0.0.1:8643/v1 \
  --hermes-model unbrewed-player
```

`--policy codex-direct` reads Hermes' `openai-codex` OAuth credentials from `~/.hermes/auth.json`, refreshes them if needed, and calls `https://chatgpt.com/backend-api/codex/responses` directly. It does not print tokens.

If `--policy fallback` is used, the CLI runs with deterministic non-forfeit choices. That is useful for smoke tests, not for intelligent play.

## Design rules

- External process, not embedded in `unbrewed-p2p`.
- Connect as a normal room seat over the public Pro WebSocket API.
- Feed the LLM only `PlayerView`, legal actions, recent redacted events, and local strategy notes.
- Validate every model choice against the exact legal action list.
- Submit the exact indexed action object, never model-authored action JSON.
- Fall back to deterministic non-forfeit policy on invalid output, timeout, or transport failure.
- Store notes, prompts, eval reports, and strategy docs here.

## Useful docs

- `docs/prior-art.md` — open-source projects and patterns worth stealing.
- `docs/architecture.md` — proposed architecture for the Hermes-backed external player.
