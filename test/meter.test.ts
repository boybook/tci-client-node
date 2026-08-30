import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TciClient,
  type TciMeterCapabilities,
  type TciMeterStreamSession,
  type TciRxMeterFrame,
  type TciTxMeterFrame,
} from '../src/index.js';
import { MockTciServer } from '../src/testing/index.js';

let server: MockTciServer | undefined;

afterEach(async () => {
  vi.useRealTimers();
  await server?.stop();
  server = undefined;
});

describe('TCI meter streams', () => {
  it('subscribes without waiting for a frame and emits typed standard readings', async () => {
    server = new MockTciServer({ echoUnknown: false });
    await server.start();
    const client = new TciClient({ url: server.url() });
    await client.connect();

    const session = await client.openMeterStream({ intervalMs: 300 });
    expect(session.requestedIntervalMs).toBe(300);
    expect(session.appliedIntervalMs).toBeUndefined();
    await waitFor(() => server!.receivedCommands.filter((command) => command.name.endsWith('sensors_enable')).length === 2);
    expect(server.receivedCommands.map((command) => command.raw)).toEqual(expect.arrayContaining([
      'RX_SENSORS_ENABLE:true,300',
      'TX_SENSORS_ENABLE:true,300',
    ]));

    const rxPromise = onceRxFrame(session);
    server.sendRxMeterFrame({ levelDbm: -71.5 });
    await expect(rxPromise).resolves.toMatchObject({ receiver: 0, channel: 0, levelDbm: -71.5, source: 'rx_channel_sensors' });

    const txPromise = onceTxFrame(session);
    server.sendTxMeterFrame({ micLevelDbm: -20, rmsPowerWatts: 12.5, peakPowerWatts: 18.25, swr: 1.4 });
    await expect(txPromise).resolves.toMatchObject({
      trx: 0,
      micLevelDbm: -20,
      rmsPowerWatts: 12.5,
      peakPowerWatts: 18.25,
      swr: 1.4,
    });
    expect(session.getCapabilities()).toMatchObject({ rxLevel: 'observed', txRmsPower: 'observed', txSwr: 'observed' });

    await session.close();
    await waitFor(() => server!.receivedCommands.filter((command) => command.raw.endsWith('ENABLE:false')).length === 2);
    expect(server.receivedCommands.map((command) => command.raw)).toEqual(expect.arrayContaining([
      'RX_SENSORS_ENABLE:false',
      'TX_SENSORS_ENABLE:false',
    ]));
    await client.disconnect();
  });

  it('clamps Thetis intervals and coalesces legacy, standard, and extended RX frames', async () => {
    server = new MockTciServer({
      echoUnknown: false,
      startupCommands: [
        'PROTOCOL:Thetis,2.0;',
        'DEVICE:ANAN7000DLE;',
        'VFO:0,0,14074000;',
        'READY;',
      ],
    });
    await server.start();
    const client = new TciClient({ url: server.url() });
    await client.connect();
    const session = await client.openMeterStream({ intervalMs: 5_000 });
    expect(session.appliedIntervalMs).toBe(1_000);
    await waitFor(() => server!.receivedCommands.some((command) => command.name === 'rx_sensors_enable'));
    expect(server.receivedCommands.some((command) => command.raw === 'RX_SENSORS_ENABLE:true,1000')).toBe(true);

    const frames: TciRxMeterFrame[] = [];
    session.on('rxFrame', (frame) => frames.push(frame));
    server.sendRxMeterFrame({ source: 'legacy', levelDbm: -80 });
    server.sendRxMeterFrame({ source: 'channel', levelDbm: -80 });
    server.sendRxMeterFrame({ source: 'extended', levelDbm: -80, averageLevelDbm: -82, peakBinDbm: -76 });
    await waitFor(() => frames.length === 1);
    expect(frames[0]).toMatchObject({
      source: 'rx_channel_sensors_ex',
      levelDbm: -80,
      averageLevelDbm: -82,
      peakBinDbm: -76,
    });
    expect(session.getCapabilities()).toMatchObject({ rxAverageLevel: 'observed', rxPeakBin: 'observed' });

    await session.close();
    await client.disconnect();
  });

  it('reports Aether fixed cadence and preserves its dBFS ALC extension', async () => {
    server = new MockTciServer({
      startupCommands: [
        'PROTOCOL:ExpertSDR3,1.5;',
        'DEVICE:AetherSDR;',
        'VFO:0,0,14074000;',
        'READY;',
      ],
    });
    await server.start();
    const client = new TciClient({ url: server.url() });
    await client.connect();
    const session = await client.openMeterStream({ intervalMs: 300 });
    expect(session.appliedIntervalMs).toBe(200);

    const txPromise = onceTxFrame(session);
    server.sendTxMeterFrame({ rmsPowerWatts: 10, peakPowerWatts: 12, swr: 1.2, alc: -2.5, extraArgs: ['future'] });
    await expect(txPromise).resolves.toMatchObject({
      alc: { value: -2.5, unit: 'dbfs' },
      extraArgs: ['future'],
    });
    expect(session.getCapabilities().txAlcDbfs).toBe('observed');

    await session.close();
    await client.disconnect();
  });

  it('keeps generic capabilities unknown until echo or an actual field is observed', async () => {
    server = new MockTciServer({
      startupCommands: ['PROTOCOL:Other,3.0;', 'DEVICE:Unknown;', 'VFO:0,0,7074000;', 'READY;'],
    });
    await server.start();
    const client = new TciClient({ url: server.url(), dialect: 'generic-observed' });
    await client.connect();
    const session = await client.openMeterStream({ tx: false });
    await waitFor(() => session.getCapabilities().rxLevel === 'acknowledged');
    expect(session.getCapabilities().txRmsPower).toBe('unknown');

    server.sendRxMeterFrame({ source: 'legacy', levelDbm: -95 });
    await onceObserved(session, 'rxLevel');
    expect(session.getCapabilities().rxLevel).toBe('observed');

    await session.close();
    await client.disconnect();
  });

  it('rejects malformed readings without mutating observed capabilities', async () => {
    server = new MockTciServer({ echoUnknown: false });
    await server.start();
    const client = new TciClient({ url: server.url() });
    await client.connect();
    const session = await client.openMeterStream();
    const errors: Error[] = [];
    const txFrames: TciTxMeterFrame[] = [];
    session.on('error', (error) => errors.push(error));
    session.on('txFrame', (frame) => txFrames.push(frame));

    server.broadcast('TX_SENSORS:0,-20,-1,5,0.5;');
    await waitFor(() => errors.length === 1);
    expect(txFrames).toHaveLength(0);
    expect(session.getCapabilities().txRmsPower).not.toBe('observed');

    await session.close();
    await client.disconnect();
  });

  it('allows one session per client and filters receiver, channel, and transmitter', async () => {
    server = new MockTciServer({ echoUnknown: false });
    await server.start();
    const client = new TciClient({ url: server.url() });
    await client.connect();
    const session = await client.openMeterStream({ receiver: 1, channel: 1, trx: 1 });
    await expect(client.openMeterStream()).rejects.toMatchObject({ code: 'protocol-error' });
    const rxFrames: TciRxMeterFrame[] = [];
    const txFrames: TciTxMeterFrame[] = [];
    session.on('rxFrame', (frame) => rxFrames.push(frame));
    session.on('txFrame', (frame) => txFrames.push(frame));
    server.sendRxMeterFrame({ receiver: 0, channel: 0, levelDbm: -70 });
    server.sendRxMeterFrame({ receiver: 1, channel: 1, levelDbm: -80 });
    server.sendTxMeterFrame({ trx: 0, rmsPowerWatts: 5 });
    server.sendTxMeterFrame({ trx: 1, rmsPowerWatts: 10 });
    await waitFor(() => rxFrames.length === 1 && txFrames.length === 1);
    expect(rxFrames[0]).toMatchObject({ receiver: 1, channel: 1 });
    expect(txFrames[0]).toMatchObject({ trx: 1, rmsPowerWatts: 10 });

    await client.disconnect();
    expect(server.receivedCommands.map((command) => command.raw)).toEqual(expect.arrayContaining([
      'RX_SENSORS_ENABLE:false',
      'TX_SENSORS_ENABLE:false',
    ]));
  });

  it('rejects invalid session selectors and empty subscriptions', async () => {
    server = new MockTciServer();
    await server.start();
    const client = new TciClient({ url: server.url() });
    await client.connect();
    await expect(client.openMeterStream({ receiver: 0.5 })).rejects.toMatchObject({ code: 'protocol-error' });
    await expect(client.openMeterStream({ intervalMs: 0 })).rejects.toMatchObject({ code: 'protocol-error' });
    await expect(client.openMeterStream({ rx: false, tx: false })).rejects.toMatchObject({ code: 'protocol-error' });
    await client.disconnect();
  });
});

function onceRxFrame(session: TciMeterStreamSession): Promise<TciRxMeterFrame> {
  return new Promise((resolve) => session.once('rxFrame', resolve));
}

function onceTxFrame(session: TciMeterStreamSession): Promise<TciTxMeterFrame> {
  return new Promise((resolve) => session.once('txFrame', resolve));
}

async function onceObserved(session: { getCapabilities: () => TciMeterCapabilities }, key: keyof TciMeterCapabilities): Promise<void> {
  await waitFor(() => session.getCapabilities()[key] === 'observed');
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for predicate');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
