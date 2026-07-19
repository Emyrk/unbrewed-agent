import { describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { runAgent } from '../src/ws-agent.js';

async function withServer(handler: (message: Record<string, unknown>, ws: import('ws').WebSocket) => void | Promise<void>): Promise<Record<string, unknown>> {
  const server = new WebSocketServer({ port: 0 });
  const address = server.address();
  if (typeof address === 'string' || address === null) throw new Error('expected tcp address');
  const seen = await new Promise<Record<string, unknown>>((resolve, reject) => {
    server.on('connection', (ws) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        void Promise.resolve(handler(msg, ws)).then(() => resolve(msg), reject);
      });
    });
    runAgent({
      wsUrl: `ws://127.0.0.1:${address.port}`,
      heroId: 'king-taranis',
      create: true,
      botDifficulty: 'hard',
      pilot: 'llm:openrouter/anthropic/claude-sonnet-4.5',
      maxActions: 1,
    }).catch(reject);
  });
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  return seen;
}

describe('pilot telemetry tag', () => {
  it('includes llm:<model> pilot on CREATE_ROOM', async () => {
    const msg = await withServer((_msg, ws) => {
      ws.close(1000, 'done');
    });

    expect(msg).toMatchObject({
      type: 'CREATE_ROOM',
      heroId: 'king-taranis',
      bot: { difficulty: 'hard' },
      pilot: 'llm:openrouter/anthropic/claude-sonnet-4.5',
    });
  });
});
