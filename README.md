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

# Create a room against a built-in server bot and let Hermes play this seat.
export HERMES_API_KEY=$(grep '^API_SERVER_KEY=' ~/.hermes/.env | cut -d= -f2-)
npx tsx src/cli.ts create-bot \
  --ws-url ws://127.0.0.1:8787 \
  --hero-id king-taranis \
  --bot easy \
  --max-actions 1

# Join an existing lobby as the external player.
npx tsx src/cli.ts join \
  --ws-url ws://127.0.0.1:8787 \
  --room-id ROOM \
  --hero-id king-taranis
```

If `HERMES_API_KEY` is unset, the CLI still runs with deterministic fallback choices. That is useful for smoke tests, not for intelligent play.

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
