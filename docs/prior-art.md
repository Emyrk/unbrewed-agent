# Prior art for Unbrewed LLM players

Research date: 2026-07-18.

## Closest architectural matches

### taso-labs/freeciv-llm

Repository: <https://github.com/taso-labs/freeciv-llm>

Why it matters:

- Adds an LLM-agent WebSocket gateway to an existing multiplayer game.
- Agents connect externally and play through an API against humans, other agents, or built-in AI.
- Has an explicit agent protocol: connect/authenticate, query game state, submit action.
- Provides LLM-optimized state formats rather than raw internal engine state.

Pattern to reuse:

```text
external agent process
  -> websocket gateway
  -> query redacted/optimized state
  -> submit structured action
  -> game remains authoritative
```

Differences from Unbrewed:

- FreeCiv is much larger and more open-ended.
- Unbrewed has a cleaner legal-action boundary, so the LLM can choose from an enumerated set instead of inventing command shapes.
- License is AGPL-3.0, so treat it as design reference, not code to copy into an MIT/proprietary mixed setup without care.

### llm-chess-arena/llm-chess-arena

Repository: <https://github.com/llm-chess-arena/llm-chess-arena>

Why it matters:

- Human-vs-LLM and LLM-vs-LLM play.
- Legal move validation and legal move highlighting.
- Prompts models for move reasoning, then validates moves.
- Supports multiple model providers, including OpenRouter.

Pattern to reuse:

- Number or otherwise normalize the legal moves.
- Ask the model to return a compact structured choice.
- Reject illegal output and retry or fall back.
- Separate explanation/narration from the actual move commit.

Differences from Unbrewed:

- Chess is perfect-information and has a compact action notation.
- Unbrewed is hidden-information and prompt-heavy, so the action serializer needs stricter redaction and exact JSON matching.
- Their browser-held API key pattern is wrong for us. Hermes/server-side calls should hold keys.

### voynow/poker-bench

Repository: <https://github.com/voynow/poker-bench>

Why it matters:

- LLM agents play an imperfect-information card game.
- Compares random, heuristic, one-shot LLM, and reasoning LLM strategies.
- Logs token usage, cost, latency, and behavioral metrics.

Pattern to reuse:

- Treat LLM style as an experimental variable: one-shot vs reasoning vs hybrid.
- Log every LLM call with latency, token/cost estimates, output validity, and selected action.
- Evaluate over many games, not anecdotes.

Differences from Unbrewed:

- Poker action space is smaller and semantically simpler.
- Unbrewed needs richer tactical summaries: fighter positions, hand sizes, schemes, combat state, prompts, sidekicks, teams.

## Useful but less direct

### datamllab/rlcard

Repository: <https://github.com/datamllab/rlcard>

Why it matters:

- Mature card-game RL framework.
- Standard environment shape includes observations and legal actions.
- Strong reminder that the policy interface should be environment-like: observation in, legal actions in, action out.

Pattern to reuse:

```text
Observation = redacted PlayerView + context
Legal actions = exact engine enumeration
Agent = pure chooseAction(observation, legalActions)
```

Not a direct base:

- Python RL environment, not a WebSocket client for a live game.
- Useful vocabulary and eval patterns, not implementation substrate.

### lmgame-org/GamingAgent

Repository: <https://github.com/lmgame-org/GamingAgent>

Why it matters:

- Broad LLM/VLM gaming agent benchmark.
- Has provider abstraction, retry logic, prompt/memory modules, and eval harness ideas.

Not a direct base:

- Focuses on benchmark/video/computer-use environments.
- Unbrewed should avoid screen/UI control. We have a real protocol and should use it.

### MineDojo/Voyager

Repository: <https://github.com/MineDojo/Voyager>

Why it matters:

- Canonical LLM game agent with skill memory.
- Shows the value of accumulating reusable skills/strategies over repeated play.

Not a direct base:

- Minecraft/code-as-action world, very different from a turn-based legal-action game.
- Pattern to borrow is persistent strategy memory, not the action loop.

## Prior-art conclusion

The closest base is `freeciv-llm` for the external WebSocket-agent shape, plus `llm-chess-arena` for legal-action validation and `poker-bench` for imperfect-information eval/cost logging.

Do not base this on browser automation or computer-use agents. Unbrewed already has the better primitive: a redacted authoritative protocol with enumerated legal actions.

## Proposed project stance

`unbrewed-agent` should be a small TypeScript external player:

```text
WebSocket room client
  -> state/action normalizer
  -> Hermes policy client
  -> legal-action validator
  -> telemetry/eval logger
```

Hermes should own the LLM call path through its API server or a dedicated profile, so provider/model/skills/memory stay centralized and API keys stay out of the public client.
