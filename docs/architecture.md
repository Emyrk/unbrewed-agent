# Architecture sketch

## Goal

Hermes plays Unbrewed externally, through the same WebSocket protocol as a human client.

The agent joins a lobby as a normal seat, observes only the redacted `STATE` payload for that seat, chooses from enumerated legal actions, and sends `ACTION` messages back to the room server.

## Non-goals

- Do not embed LLM calls in `unbrewed-p2p`.
- Do not move rules logic into the public client.
- Do not feed raw engine `GameState` to the model.
- Do not let the model submit free-form invented actions.
- Do not use browser automation unless the protocol path is blocked.

## Main components

```text
unbrewed-agent CLI
  ├─ Pro WebSocket client
  ├─ Seat/session manager
  ├─ Observation builder
  ├─ Action indexer
  ├─ Hermes policy client
  ├─ Output parser + validator
  ├─ Fallback policy
  └─ Game/eval logger
```

## Runtime flow

```text
1. Connect to Unbrewed Pro WebSocket server.
2. Join or create a room as a normal player seat.
3. Receive STATE messages.
4. If it is our turn/prompt, build an observation:
   - redacted PlayerView
   - exact legalActions for us
   - recent redacted events
   - compact action history summary
   - optional strategy notes from this repo
5. Index legal actions: 0..N-1.
6. Ask Hermes for JSON only:
   { "choice": number, "confidence": number, "reason": string }
7. Validate `choice` is in range and action still matches current legalActions.
8. Submit the selected action over WebSocket.
9. Log prompt digest, model output, selected action, latency, validity, and result.
10. On invalid output, timeout, or disconnect, retry once or fall back.
```

## Hermes integration options

### Option A: Hermes API server, recommended MVP

Use the local Hermes gateway API server:

```text
POST http://localhost:8642/v1/chat/completions
Authorization: Bearer $HERMES_API_KEY
model: hermes-agent, or a dedicated profile model id
```

Pros:

- Hermes owns provider config and API keys.
- Switching OpenRouter/OpenAI/Anthropic is a Hermes config change.
- Can target a dedicated low-tool profile for gameplay.
- Works from a normal TypeScript client.

Cons:

- API server call latency is chat-agent latency, not raw provider latency.
- The API server does not expose strict JSON mode or tool choice controls, so the client must parse defensively.

Mitigation:

- Dedicated `unbrewed-player` Hermes profile.
- `agent.max_turns: 1`.
- Minimal or no toolsets.
- System prompt says: do not call tools, JSON only.

### Option B: Spawn `hermes chat -q` per move

Useful for debugging only. Too slow and process-heavy for live play.

### Option C: Hermes plugin/tool for Unbrewed

Later, Hermes could expose a custom tool like `unbrewed_choose_action`, but that inverts control. The game client should still remain the long-running process that owns the WebSocket connection.

## Prompt contract

System prompt:

```text
You are playing Unbrewed Pro as an external policy client.
You do not know hidden opponent information beyond the provided redacted view.
Choose exactly one legal action by index.
Do not call tools.
Output JSON only, no markdown.
```

User message shape:

```json
{
  "role": "active player or prompt responder",
  "objective": "win the match",
  "view": {},
  "recentEvents": [],
  "legalActions": [
    { "index": 0, "action": {}, "summary": "..." }
  ],
  "strategyNotes": []
}
```

Output shape:

```json
{
  "choice": 0,
  "confidence": 0.62,
  "reason": "Short tactical reason. No hidden-info claims."
}
```

## Safety boundaries

- Only serialize `PlayerView`, never raw `GameState`.
- Legal actions are the action allowlist.
- Submit the exact indexed action object, not model-authored JSON.
- Re-check current legal actions before submit if a new STATE arrived while thinking.
- Timeout per move. Default target: 20-45 seconds for live play, longer for eval.
- Fallback policy must never forfeit unless explicitly configured.

## Evaluation metrics

- Win/loss by hero/map/format/opponent policy.
- Invalid output rate.
- Retry rate.
- Timeout rate.
- Average move latency.
- Token/cost per game.
- Action distribution by phase.
- Blunder tags, initially manual, later heuristic.

## First milestone

Build a local harness that plays complete games against the existing engine bots without touching production lobbies.

Then build the live WebSocket seat client.
