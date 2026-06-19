import { afterEach, describe, expect, it } from 'vitest';
import { TciClient, TciStreamType, payloadToFloat32, type TciClientEvents } from '../src/index.js';
import { MockTciServer } from '../src/testing/index.js';

let server: MockTciServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

it('runs connect -> startup -> command ack -> audio -> tx chrono -> tx audio', async () => {
  server = new MockTciServer();
  await server.start();
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 500 });
  const ready = onceClientEvent(client, 'ready');
  await client.connect();
  await ready;
  expect(client.getState().protocol).toBe('2.0');

  await client.setFrequency(14_075_000);
  await client.setMode('digu');
  await client.setPtt(true, { source: 'tci' });
  await client.configureAudio({ sampleRate: 12_000, sampleType: 'float32', channels: 1, samplesPerFrame: 512 });
  await client.startAudio();

  const rx = onceClientEvent(client, 'rxAudioFrame');
  server.sendRxAudioFrame({ samples: new Float32Array([0, 0.5, -0.5]) });
  const [rxFrame] = await rx;
  expect(Array.from(payloadToFloat32(rxFrame))).toEqual([0, 0.5, -0.5]);

  const chrono = onceClientEvent(client, 'txChrono');
  server.sendTxChrono({ sampleCount: 4 });
  const [request] = await chrono;
  expect(request.sampleCount).toBe(4);
  client.sendTxAudio({ sampleRate: request.sampleRate, sampleType: request.sampleType, channels: request.channels, samples: new Float32Array(4) });
  await waitFor(() => server!.receivedTxAudioFrames.length === 1);
  expect(server.receivedTxAudioFrames[0]?.streamType).toBe(TciStreamType.TX_AUDIO_STREAM);

  await client.disconnect();
});

it('resolves setFrequency only on the final matching state after band-change noise', async () => {
  server = new MockTciServer();
  server.onCommand(({ socket, command }) => {
    if (command.name === 'vfo' && command.args[2] === '21074000') {
      socket.send('VFO:0,0,14074000;');
      setTimeout(() => socket.send('VFO:0,0,21074000;'), 50);
      return true;
    }
    return false;
  });
  await server.start();
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 500 });
  const ready = onceClientEvent(client, 'ready');
  await client.connect();
  await ready;
  await client.setFrequency(21_074_000);
  expect(client.getState().frequencies['0:0']).toBe(21_074_000);
  await client.disconnect();
});

it('marks state disconnected and rejects queued commands on server close', async () => {
  server = new MockTciServer({ commandDelayMs: 100 });
  await server.start();
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 500 });
  const ready = onceClientEvent(client, 'ready');
  await client.connect();
  await ready;
  const pending = client.setFrequency(7_074_000);
  server.closeClients();
  await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  await waitFor(() => client.getState().connected === false);
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for predicate');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function onceClientEvent<K extends keyof TciClientEvents>(client: TciClient, event: K): Promise<Parameters<TciClientEvents[K]>> {
  return new Promise((resolve) => client.once(event, (...args) => resolve(args as Parameters<TciClientEvents[K]>)));
}
