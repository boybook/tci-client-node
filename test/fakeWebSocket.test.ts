import { expect, it } from 'vitest';
import { TciClient } from '../src/index.js';
import { createFakeWebSocketImpl, type FakeWebSocket } from '../src/testing/index.js';

it('drives TciClient with the in-memory fake WebSocket transport', async () => {
  let socket: FakeWebSocket | undefined;
  const client = new TciClient({
    url: 'ws://fake-tci.local:40001',
    commandTimeoutMs: 100,
    WebSocketImpl: createFakeWebSocketImpl((created) => {
      socket = created;
    }),
  });

  const connecting = client.connect();
  await Promise.resolve();
  socket!.receive('PROTOCOL:ExpertSDR3,2.0;DEVICE:SunSDR2PRO;VFO:0,0,7100000;READY;');
  await connecting;

  const frequency = client.setFrequency(14_074_000);
  expect(socket!.sentMessages.at(-1)?.data).toBe('VFO:0,0,14074000;');
  socket!.receive('VFO:0,0,14074000;');

  await expect(frequency).resolves.toBeUndefined();
  expect(client.getState().frequencies['0:0']).toBe(14_074_000);
  await client.disconnect();
});
