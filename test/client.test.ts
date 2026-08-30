import { afterEach, describe, expect, it } from 'vitest';
import { TciClient, TciStreamType, decodeInterleavedIq, payloadToFloat32, type TciClientEvents } from '../src/index.js';
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
  expect(request.frame.payloadLength).toBe(0);
  client.sendTxAudioForChrono(request, new Float32Array([0.1, 0.2]));
  await waitFor(() => server!.receivedTxAudioFrames.length === 1);
  expect(server.receivedTxAudioFrames[0]?.streamType).toBe(TciStreamType.TX_AUDIO_STREAM);
  expect(server.receivedTxAudioFrames[0]?.sampleCount).toBe(4);
  expect(Array.from(payloadToFloat32(server.receivedTxAudioFrames[0]!))).toEqual([expect.closeTo(0.1, 4), expect.closeTo(0.2, 4), 0, 0]);

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
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 500, frequencyWriteSettleMs: 20 });
  const ready = onceClientEvent(client, 'ready');
  await client.connect();
  await ready;
  await client.setFrequency(21_074_000);
  expect(client.getState().frequencies['0:0']).toBe(21_074_000);
  await client.disconnect();
});

it('treats already-applied frequency and PTT writes as idempotent when the server would not echo', async () => {
  server = new MockTciServer({
    startupCommands: [
      'PROTOCOL:2.0;',
      'DEVICE:Mock ExpertSDR3;',
      'VFO:0,0,7074000;',
      'TRX:0,false;',
      'READY:true;',
    ],
  });
  server.onCommand(({ command }) => command.name === 'vfo' || command.name === 'trx');
  await server.start();
  const client = new TciClient({ url: server.url(), writeTimeoutMs: 30, frequencyWriteSettleMs: 0 });
  const ready = onceClientEvent(client, 'ready');
  await client.connect();
  await ready;

  await client.setPtt(false, { timeoutMs: 30 });
  await client.setFrequency(7_074_000, 0, 0, { timeoutMs: 30, settleMs: 0 });

  expect(server.receivedCommands.filter((command) => command.name === 'trx')).toHaveLength(0);
  expect(server.receivedCommands.filter((command) => command.name === 'vfo')).toHaveLength(0);
  expect(client.getState().connected).toBe(true);
  await client.disconnect();
});

it('keeps the socket connected when a state-based write confirmation times out', async () => {
  server = new MockTciServer();
  server.onCommand(({ command }) => command.name === 'vfo');
  await server.start();
  const client = new TciClient({ url: server.url(), writeTimeoutMs: 30, frequencyWriteSettleMs: 0 });
  const ready = onceClientEvent(client, 'ready');
  await client.connect();
  await ready;

  await expect(client.setFrequency(7_074_000, 0, 0, { timeoutMs: 30, settleMs: 0 })).rejects.toMatchObject({
    code: 'command-timeout',
  });
  expect(client.getState().connected).toBe(true);
  expect(client.isConnected()).toBe(true);
  await client.disconnect();
});

it('accepts a Thetis constrained DRIVE state as a clamped write result', async () => {
  server = new MockTciServer({
    startupCommands: [
      'PROTOCOL:ExpertSDR3,2.0;',
      'DEVICE:ANAN7000DLE;',
      'TX_PROFILES_EX:Default;',
      'VFO:0,0,14074000;',
      'DRIVE:0,30;',
      'READY;',
    ],
  });
  server.onCommand(({ socket, command }) => {
    if (command.name === 'drive' && command.args[1] === '100') {
      socket.send('DRIVE:0,50;');
      return true;
    }
    return false;
  });
  await server.start();
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 100 });
  const handshake = await client.connect();

  expect(handshake.dialect.dialect.id).toBe('thetis-2.0');
  await expect(client.setDriveWithResult(100)).resolves.toEqual({
    requested: 100,
    applied: 50,
    outcome: 'clamped',
    acknowledgement: 'state',
  });
  expect(client.getState().drive['0']).toBe(50);
  await client.disconnect();
});

it('uses the TCI 1.4 DRIVE shape selected by the handshake', async () => {
  server = new MockTciServer({
    startupCommands: ['PROTOCOL:ExpertSDR,1.4;', 'DEVICE:SunSDR;', 'VFO:0,0,7100000;', 'DRIVE:30;', 'READY;'],
  });
  server.onCommand(({ socket, command }) => {
    if (command.name === 'drive') {
      socket.send(`DRIVE:${command.args[0] ?? '40'};`);
      return true;
    }
    return false;
  });
  await server.start();
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 100 });
  await client.connect();
  await client.setDriveWithResult(40);
  expect(server.receivedCommands.some((command) => command.raw === 'DRIVE:40')).toBe(true);
  await client.disconnect();
});

it('rejects a WebSocket that does not provide enough TCI initialization evidence', async () => {
  server = new MockTciServer({ startupCommands: ['READY;'] });
  await server.start();
  const client = new TciClient({ url: server.url(), handshakeTimeoutMs: 100 });
  client.on('error', () => undefined);
  await expect(client.connect()).rejects.toMatchObject({ code: 'invalid-handshake' });
});

it('parses AetherSDR 1.5 audio with modern scalar stream semantics', async () => {
  server = new MockTciServer({
    startupCommands: [
      'PROTOCOL:ExpertSDR3,1.5;',
      'DEVICE:AetherSDR;',
      'VFO:0,0,14100000;',
      'AUDIO_STREAM_CHANNELS:2;',
      'AUDIO_STREAM_SAMPLES:2048;',
      'READY;',
    ],
  });
  await server.start();
  const client = new TciClient({ url: server.url() });
  await client.connect();
  const received = onceClientEvent(client, 'rxAudioFrame');
  server.sendRxAudioFrame({ channels: 2, samples: new Float32Array([0.1, -0.1, 0.2, -0.2]) });
  const [frame] = await received;
  expect(client.getHandshakeResult()?.dialect.dialect.id).toBe('aethersdr-1.5');
  expect(frame).toMatchObject({ headerSampleCount: 4, sampleCount: 4, frameCount: 2, lengthSemantics: 'scalar' });
  await client.disconnect();
});

it('opens a standard IQ session with DDS metadata and closes it cleanly', async () => {
  server = new MockTciServer();
  server.onCommand(({ server: mock, command }) => {
    if (command.name === 'iq_start') {
      queueMicrotask(() => mock.sendIqFrame({
        sampleRate: 96_000,
        samples: new Float32Array([0.1, -0.1, 0.2, -0.2]),
      }));
    }
    return false;
  });
  await server.start();
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 200 });
  await client.connect();

  expect(client.getIqCapabilities()).toEqual({
    supported: true,
    currentSampleRate: 48_000,
    supportedSampleRates: [48_000, 96_000, 192_000, 384_000],
  });
  const session = await client.openIqStream({ receiver: 0, sampleRate: 96_000, firstFrameTimeoutMs: 200 });
  expect(session.appliedSampleRate).toBe(96_000);
  const nextFrame = onceClientEvent(client, 'iqFrame');
  server.sendIqFrame({ sampleRate: 96_000, samples: new Float32Array([0.3, -0.3]) });
  const [iq] = await nextFrame;
  expect(iq).toMatchObject({ receiver: 0, sampleRate: 96_000, centerFrequency: 14_074_000, complexSampleCount: 1 });
  expect(Array.from(decodeInterleavedIq(iq.frame))).toEqual([expect.closeTo(0.3, 5), expect.closeTo(-0.3, 5)]);

  await session.close();
  await waitFor(() => server!.receivedCommands.some((command) => command.raw === 'IQ_STOP:0'));
  expect(client.getState().iq.activeReceivers['0']).toBe(false);
  await client.disconnect();
});

it('uses the first IQ frame as startup acknowledgement when Aether does not echo IQ_START', async () => {
  server = new MockTciServer({
    startupCommands: [
      'PROTOCOL:ExpertSDR3,1.5;',
      'DEVICE:AetherSDR;',
      'DDS:0,14100000;',
      'IQ_SAMPLERATE:48000;',
      'READY;',
    ],
  });
  server.onCommand(({ socket, server: mock, command }) => {
    if (command.name === 'iq_samplerate') {
      socket.send('IQ_SAMPLERATE:48000;');
      return true;
    }
    if (command.name === 'iq_start') {
      queueMicrotask(() => mock.sendIqFrame({ sampleRate: 48_000, samples: new Float32Array([0.1, 0.2]) }));
      return true;
    }
    if (command.name === 'iq_stop') return true;
    return false;
  });
  await server.start();
  const client = new TciClient({ url: server.url(), commandTimeoutMs: 200 });
  await client.connect();
  const session = await client.openIqStream({ sampleRate: 96_000, firstFrameTimeoutMs: 200 });
  expect(session.appliedSampleRate).toBe(48_000);
  expect(client.getIqCapabilities().supportedSampleRates).toEqual([24_000, 48_000, 96_000, 192_000]);
  await expect(client.openIqStream()).rejects.toMatchObject({ code: 'protocol-error' });
  await session.close();
  await client.disconnect();
});

it('reports IQ unsupported for an observed dialect without IQ initialization evidence', async () => {
  server = new MockTciServer({
    startupCommands: ['PROTOCOL:Other,3.0;', 'DEVICE:Unknown;', 'VFO:0,0,7074000;', 'READY;'],
  });
  await server.start();
  const client = new TciClient({ url: server.url(), dialect: 'generic-observed' });
  await client.connect();
  expect(client.getIqCapabilities()).toEqual({ supported: false, currentSampleRate: undefined, supportedSampleRates: [] });
  await expect(client.openIqStream()).rejects.toMatchObject({ code: 'protocol-error' });
  await client.disconnect();
});

it('falls back to readback when TUNE and SPLIT repeat writes are not echoed', async () => {
  server = new MockTciServer();
  server.onCommand(({ socket, command }) => {
    if (command.name === 'tune') {
      if (command.args.length === 1) socket.send('TUNE:0,false;');
      return true;
    }
    if (command.name === 'split_enable') {
      if (command.args.length === 1) socket.send('SPLIT_ENABLE:0,false;');
      return true;
    }
    return false;
  });
  await server.start();
  const client = new TciClient({ url: server.url(), writeTimeoutMs: 25, commandTimeoutMs: 100 });
  await client.connect();
  await expect(client.setTune(false)).resolves.toBeUndefined();
  await expect(client.setSplit(false)).resolves.toBeUndefined();
  expect(server.receivedCommands.map((command) => command.raw)).toEqual(expect.arrayContaining([
    'TUNE:0,false',
    'TUNE:0',
    'SPLIT_ENABLE:0,false',
    'SPLIT_ENABLE:0',
  ]));
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
