#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { HermesClient } from './hermes.js';
import { runAgent } from './ws-agent.js';

interface CliOptions {
  command: string;
  wsUrl: string;
  roomId?: string;
  heroId: string;
  botDifficulty?: 'easy' | 'medium' | 'hard';
  hermesBaseUrl: string;
  hermesModel: string;
  hermesKey?: string | undefined;
  timeoutMs: number;
  maxActions?: number;
  notesPath?: string;
}

function usage(): string {
  return `unbrewed-agent

Commands:
  join        Join an existing room as an external Hermes-backed player
  create-bot  Create a room against a built-in server bot

Options:
  --ws-url URL            Pro WebSocket URL, default ws://localhost:8787
  --room-id ID            Room to join, required for join
  --hero-id ID            Hero id for this seat, default king-taranis
  --bot DIFFICULTY        easy|medium|hard for create-bot, default easy
  --hermes-url URL        Hermes API base, default http://localhost:8642/v1
  --hermes-model ID       Hermes API model/profile id, default hermes-agent
  --hermes-key KEY        Hermes API key, default HERMES_API_KEY
  --timeout-ms N          Hermes call timeout, default 45000
  --max-actions N         Stop after N submitted actions, useful for smoke tests
  --notes PATH            Text file with strategy notes, one non-empty line per note

If no Hermes key is provided, the agent still runs with deterministic fallback choices.
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
    hermesBaseUrl: 'http://localhost:8642/v1',
    hermesModel: 'hermes-agent',
    hermesKey: process.env.HERMES_API_KEY,
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
      case '--hermes-url': opts.hermesBaseUrl = value; break;
      case '--hermes-model': opts.hermesModel = value; break;
      case '--hermes-key': opts.hermesKey = value; break;
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

function loadNotes(path: string | undefined): string[] {
  if (!path) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

const opts = parseArgs(process.argv.slice(2));
if (opts.command !== 'join' && opts.command !== 'create-bot') {
  throw new Error(`Unknown command ${opts.command}\n\n${usage()}`);
}
if (opts.command === 'join' && !opts.roomId) throw new Error('--room-id is required for join');

const hermes = opts.hermesKey
  ? new HermesClient({ baseUrl: opts.hermesBaseUrl, apiKey: opts.hermesKey, model: opts.hermesModel, timeoutMs: opts.timeoutMs })
  : undefined;

const result = await runAgent({
  wsUrl: opts.wsUrl,
  roomId: opts.roomId,
  heroId: opts.heroId,
  create: opts.command === 'create-bot',
  botDifficulty: opts.command === 'create-bot' ? opts.botDifficulty : undefined,
  hermes,
  maxActions: opts.maxActions,
  strategyNotes: loadNotes(opts.notesPath),
});

console.log(JSON.stringify({ event: 'agent_finished', ...result }));
