#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { CodexDirectClient } from './codex-direct.js';
import { HermesClient, type PolicyClient } from './hermes.js';
import { runAgent } from './ws-agent.js';

interface CliOptions {
  command: string;
  wsUrl: string;
  roomId?: string;
  heroId: string;
  botDifficulty?: 'easy' | 'medium' | 'hard';
  policy: 'hermes' | 'codex-direct' | 'fallback';
  hermesBaseUrl: string;
  hermesModel: string;
  hermesKey?: string | undefined;
  codexModel: string;
  codexAuthPath?: string | undefined;
  codexReasoning: 'low' | 'medium' | 'high';
  pilot?: string | undefined;
  timeoutMs: number;
  maxActions?: number;
  notesPath?: string;
}

function usage(): string {
  return `unbrewed-agent

Commands:
  join        Join an existing room as an external LLM-backed player
  create-bot  Create a room against a built-in server bot

Options:
  --ws-url URL            Pro WebSocket URL, default ws://localhost:8787
  --room-id ID            Room to join, required for join
  --hero-id ID            Hero id for this seat, default king-taranis
  --bot DIFFICULTY        easy|medium|hard for create-bot, default easy
  --policy MODE           hermes|codex-direct|fallback, default hermes
  --hermes-url URL        Hermes API base, default http://localhost:8642/v1
  --hermes-model ID       Hermes API model/profile id, default hermes-agent
  --hermes-key KEY        Hermes API key, default HERMES_API_KEY
  --codex-model ID        Codex direct model, default gpt-5.5
  --codex-auth-path PATH  Hermes auth.json path, default $HERMES_HOME/auth.json or ~/.hermes/auth.json
  --codex-reasoning LVL   low|medium|high, default low
  --pilot LABEL           Telemetry pilot label, default llm:<model> for model policies
  --timeout-ms N          Policy call timeout, default 45000
  --max-actions N         Stop after N submitted actions, useful for smoke tests
  --notes PATH            Text file with strategy notes, one non-empty line per note

Policy modes:
  hermes        Calls a Hermes API server. Uses HERMES_API_KEY unless --hermes-key is passed.
  codex-direct  Reads Hermes openai-codex OAuth from auth.json and calls ChatGPT Codex Responses directly.
  fallback      No model call. Deterministic non-forfeit choices only.
`;
}

function parseArgs(argv: string[]): CliOptions {
  const command = argv[0] ?? '--help';
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log(usage());
    process.exit(0);
  }
  const opts: CliOptions = {
    command,
    wsUrl: 'ws://localhost:8787',
    heroId: 'king-taranis',
    botDifficulty: 'easy',
    policy: 'hermes',
    hermesBaseUrl: 'http://localhost:8642/v1',
    hermesModel: 'hermes-agent',
    hermesKey: process.env.HERMES_API_KEY,
    codexModel: 'gpt-5.5',
    codexReasoning: 'low',
    timeoutMs: 45_000,
  };
  for (let i = 1; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    if (value === undefined) throw new Error(`Missing value for ${key}`);
    i++;
    switch (key) {
      case '--ws-url': opts.wsUrl = value; break;
      case '--room-id': opts.roomId = value; break;
      case '--hero-id': opts.heroId = value; break;
      case '--bot': opts.botDifficulty = parseDifficulty(value); break;
      case '--policy': opts.policy = parsePolicy(value); break;
      case '--hermes-url': opts.hermesBaseUrl = value; break;
      case '--hermes-model': opts.hermesModel = value; break;
      case '--hermes-key': opts.hermesKey = value; break;
      case '--codex-model': opts.codexModel = value; break;
      case '--codex-auth-path': opts.codexAuthPath = value; break;
      case '--codex-reasoning': opts.codexReasoning = parseReasoning(value); break;
      case '--pilot': opts.pilot = value; break;
      case '--timeout-ms': opts.timeoutMs = Number(value); break;
      case '--max-actions': opts.maxActions = Number(value); break;
      case '--notes': opts.notesPath = value; break;
      default: throw new Error(`Unknown option ${key}`);
    }
  }
  return opts;
}

function parseDifficulty(value: string): 'easy' | 'medium' | 'hard' {
  if (value === 'easy' || value === 'medium' || value === 'hard') return value;
  throw new Error(`Invalid bot difficulty ${value}`);
}

function parsePolicy(value: string): 'hermes' | 'codex-direct' | 'fallback' {
  if (value === 'hermes' || value === 'codex-direct' || value === 'fallback') return value;
  throw new Error(`Invalid policy ${value}`);
}

function parseReasoning(value: string): 'low' | 'medium' | 'high' {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  throw new Error(`Invalid Codex reasoning level ${value}`);
}

function loadNotes(path: string | undefined): string[] {
  if (!path) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function buildPolicyClient(opts: CliOptions): PolicyClient | undefined {
  if (opts.policy === 'fallback') return undefined;
  if (opts.policy === 'codex-direct') {
    return new CodexDirectClient({
      authPath: opts.codexAuthPath,
      model: opts.codexModel,
      timeoutMs: opts.timeoutMs,
      reasoningEffort: opts.codexReasoning,
    });
  }
  if (!opts.hermesKey) return undefined;
  return new HermesClient({ baseUrl: opts.hermesBaseUrl, apiKey: opts.hermesKey, model: opts.hermesModel, timeoutMs: opts.timeoutMs });
}

function defaultPilot(opts: CliOptions): string {
  if (opts.pilot) return opts.pilot;
  if (opts.policy === 'fallback') return 'human';
  const model = opts.policy === 'codex-direct' ? opts.codexModel : opts.hermesModel;
  return `llm:${model}`;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.command !== 'join' && opts.command !== 'create-bot') {
  throw new Error(`Unknown command ${opts.command}\n\n${usage()}`);
}
if (opts.command === 'join' && !opts.roomId) throw new Error('--room-id is required for join');
if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error('--timeout-ms must be a positive number');
if (opts.maxActions !== undefined && (!Number.isFinite(opts.maxActions) || opts.maxActions <= 0)) {
  throw new Error('--max-actions must be a positive number');
}

const hermes = buildPolicyClient(opts);
console.log(JSON.stringify({ event: 'agent_starting', policy: opts.policy, model: opts.policy === 'codex-direct' ? opts.codexModel : opts.hermesModel, pilot: defaultPilot(opts), timeoutMs: opts.timeoutMs }));

const result = await runAgent({
  wsUrl: opts.wsUrl,
  roomId: opts.roomId,
  heroId: opts.heroId,
  create: opts.command === 'create-bot',
  botDifficulty: opts.command === 'create-bot' ? opts.botDifficulty : undefined,
  pilot: defaultPilot(opts),
  hermes,
  maxActions: opts.maxActions,
  strategyNotes: loadNotes(opts.notesPath),
});

console.log(JSON.stringify({ event: 'agent_finished', ...result }));
