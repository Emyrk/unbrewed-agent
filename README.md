# unbrewed-agent

External LLM player for Unbrewed Pro.

Goal: let Hermes join an Unbrewed lobby through the same public WebSocket protocol a human client uses, receive only redacted player views and enumerated legal actions, then choose actions via Hermes-managed LLM calls.

The engine stays authoritative. The agent is only a policy client.

## Initial direction

- External process, not embedded in `unbrewed-p2p`.
- Connect as a normal room seat over the public Pro WebSocket API.
- Feed the LLM only `PlayerView`, legal actions, recent redacted events, and local strategy notes.
- Validate every model choice against the exact legal action list.
- Fall back to deterministic bot policy on invalid output, timeout, or transport failure.
- Store notes, prompts, eval reports, and strategy docs here.

## Useful docs

- `docs/prior-art.md` — open-source projects and patterns worth stealing.
- `docs/architecture.md` — proposed architecture for the Hermes-backed external player.
