import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TciClient, type TciClientOptions } from '../src/index.js';
import { createFakeWebSocketImpl, type FakeWebSocket } from '../src/testing/index.js';

let client: TciClient;
let socket: FakeWebSocket;

async function connect(options: Partial<TciClientOptions> = {}) {
  client = new TciClient({
    url: 'ws://fake-tci.local',
    writeTimeoutMs: 120,
    frequencyWriteSettleMs: 10,
    ...options,
    WebSocketImpl: createFakeWebSocketImpl((created) => { socket = created; }),
  });
  const connecting = client.connect();
  await Promise.resolve();
  socket.receive('PROTOCOL:Thetis,2.0;DEVICE:ANAN7000DLE;VFO:0,0,14074000;DDS:0,14073400;MODULATION:0,CWU;TRX:0,false;READY;');
  await connecting;
}

function sent() { return socket.sentMessages.map((message) => message.data); }

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await client?.disconnect();
  vi.useRealTimers();
});

describe('dialect frequency confirmation', () => {
  it('recovers a missing Thetis broadcast with one read-only probe in the original deadline', async () => {
    await connect();
    socket.on('sent', (raw) => {
      if (raw === 'VFO:0,0;') socket.receive('VFO:0,0,7074000;');
    });
    let done = false;
    const writing = client.setFrequency(7_074_000).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(39);
    expect(done).toBe(false);
    expect(sent()).toEqual(['VFO:0,0,7074000;']);
    await vi.advanceTimersByTimeAsync(11);
    await writing;
    expect(client.getState().frequencies['0:0']).toBe(7_074_000);
    expect(sent()).toEqual(['VFO:0,0,7074000;', 'VFO:0,0;']);
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toHaveLength(2);
  });

  it('keeps the same pending write through transient band-switch states', async () => {
    await connect();
    let done = false;
    const writing = client.setFrequency(21_074_000).then(() => { done = true; });
    socket.receive('VFO:0,0,21074000;');
    await vi.advanceTimersByTimeAsync(5);
    socket.receive('VFO:0,0,14074000;');
    await vi.advanceTimersByTimeAsync(70);
    expect(done).toBe(false);
    socket.receive('VFO:0,0,21074000;');
    await vi.advanceTimersByTimeAsync(10);
    await writing;
    expect(sent().filter((raw) => raw === 'VFO:0,0,21074000;')).toHaveLength(1);
  });

  it.each([
    '',
    'VFO:1,0,7074000;VFO:0,1,7074000;',
    'VFO:0,0,14074000;',
    'VFO:0,0,NaN;VFO:0,0,-1;',
  ])('does not report a successful VFO write for missing, unrelated or rejected state: %s', async (response) => {
    await connect();
    socket.on('sent', () => { if (response) socket.receive(response); });
    const rejected = expect(client.setFrequency(7_074_000)).rejects.toMatchObject({
      code: 'command-timeout',
      details: { requestedHz: 7_074_000, address: [0, 0], readbackSent: true },
    });
    await vi.advanceTimersByTimeAsync(120);
    await rejected;
    expect(client.isConnected()).toBe(true);
    expect(sent()).toHaveLength(2);
  });

  it('cancels the readback probe and confirmation when the session disconnects', async () => {
    await connect();
    const rejected = expect(client.setFrequency(7_074_000)).rejects.toMatchObject({ code: 'disconnected' });
    await client.disconnect();
    await rejected;
    await vi.advanceTimersByTimeAsync(300);
    expect(sent()).toEqual(['VFO:0,0,7074000;']);
    expect(client.listenerCount('command')).toBe(0);
  });

  it.each([600, -600])('preserves the reported DDS center with a %i Hz CW shift', async (shift) => {
    await connect();
    socket.on('sent', (raw) => {
      if (raw === 'DDS:0;') socket.receive(`DDS:0,${7_075_000 + shift};`);
    });
    let done = false;
    const writing = client.setDdsFrequency(7_075_000).then(() => { done = true; });
    socket.receive('DDS:1,7075000;');
    await vi.advanceTimersByTimeAsync(39);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(11);
    await writing;
    expect(client.getState().dds['0']).toBe(7_075_000 + shift);
    expect(client.getState().frequencies['0:0']).toBe(14_074_000);
    expect(sent()).toEqual(['DDS:0,7075000;', 'DDS:0;']);
  });

  it('requires a fresh DDS observation even when its cached value equals the raw write', async () => {
    await connect();
    const rejected = expect(client.setDdsFrequency(14_073_400)).rejects.toMatchObject({ code: 'command-timeout' });
    await vi.advanceTimersByTimeAsync(120);
    await rejected;
    expect(sent()[0]).toBe('DDS:0,14073400;');
  });

  it('cannot confirm a new session using an old session cache or delayed transport event', async () => {
    await connect();
    const previous = socket;
    await client.disconnect();
    const reconnecting = client.connect();
    await Promise.resolve();
    socket.receive('PROTOCOL:Thetis,2.0;DEVICE:ANAN7000DLE;MODULATION:0,CWU;READY;');
    await reconnecting;
    const rejected = expect(client.setFrequency(14_074_000)).rejects.toMatchObject({ code: 'command-timeout' });
    previous.emit('message', Buffer.from('VFO:0,0,14074000;'), false);
    await vi.advanceTimersByTimeAsync(120);
    await rejected;
    expect(client.getState().frequencies['0:0']).toBeUndefined();
    expect(sent()[0]).toBe('VFO:0,0,14074000;');
  });

  it('retains strict confirmation and no extra probe for a standard dialect', async () => {
    await connect({ dialect: 'expertsdr-1.9-2.0' });
    const rejected = expect(client.setFrequency(7_074_000)).rejects.toMatchObject({ code: 'command-timeout' });
    await vi.advanceTimersByTimeAsync(120);
    await rejected;
    expect(sent()).toEqual(['VFO:0,0,7074000;']);
  });

  it('honors an explicitly requested optimistic mode without changing its state cache', async () => {
    await connect({ writeAckMode: 'optimistic' });
    await client.setFrequency(7_074_000);
    await vi.advanceTimersByTimeAsync(300);
    expect(client.getState().frequencies['0:0']).toBe(14_074_000);
    expect(sent()).toEqual(['VFO:0,0,7074000;']);
  });

  it('does not weaken PTT confirmation for an asynchronous frequency dialect', async () => {
    await connect();
    const rejected = expect(client.setPtt(true)).rejects.toMatchObject({ code: 'command-timeout' });
    await vi.advanceTimersByTimeAsync(120);
    await rejected;
    expect(sent()).toEqual(['TRX:0,true;']);
  });
});
