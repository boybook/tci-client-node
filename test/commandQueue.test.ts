import { describe, expect, it } from 'vitest';
import { TciError } from '../src/errors.js';
import { TciCommandQueue, parseTciText } from '../src/protocol/index.js';

it('serializes commands and ignores interleaved broadcasts', async () => {
  const sent: string[] = [];
  const queue = new TciCommandQueue({ send: (raw) => { sent.push(raw); }, timeoutMs: 100 });
  const first = queue.enqueue('VFO:0,0,14074000;');
  const second = queue.enqueue('TRX:0,true,tci;');

  expect(sent).toEqual(['VFO:0,0,14074000;']);
  expect(queue.handleCommand(parseTciText('RX_CHANNEL_SENSORS:0,0,-71.5;')[0]!)).toBe(false);
  expect(queue.handleCommand(parseTciText('VFO:0,0,7100000;')[0]!)).toBe(false);
  expect(queue.handleCommand(parseTciText('VFO:0,0,14074000;')[0]!)).toBe(true);
  await expect(first).resolves.toMatchObject({ reply: { name: 'vfo' } });
  expect(sent).toEqual(['VFO:0,0,14074000;', 'TRX:0,true,tci;']);
  expect(queue.handleCommand(parseTciText('TRX:0,true,tci;')[0]!)).toBe(true);
  await expect(second).resolves.toMatchObject({ reply: { name: 'trx' } });
});

it('times out and cancels pending commands on disconnect', async () => {
  const queue = new TciCommandQueue({ send: () => undefined, timeoutMs: 10 });
  await expect(queue.enqueue('VFO:0,0;')).rejects.toMatchObject({ code: 'command-timeout' });

  const pending = queue.enqueue('TRX:0,true;');
  queue.setConnected(false);
  await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
  await expect(queue.enqueue('TRX:0,false;')).rejects.toMatchObject({ code: 'not-connected' });
});

it('removes aborted active and queued commands without stalling the queue', async () => {
  const sent: string[] = [];
  const queue = new TciCommandQueue({ send: (raw) => { sent.push(raw); }, timeoutMs: 100 });
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();

  const active = queue.enqueue('VFO:0,0,14074000;', { signal: activeAbort.signal });
  const abortedQueued = queue.enqueue('TRX:0,true,tci;', { signal: queuedAbort.signal });
  const next = queue.enqueue('DRIVE:0,50;');

  expect(sent).toEqual(['VFO:0,0,14074000;']);

  queuedAbort.abort();
  await expect(abortedQueued).rejects.toMatchObject({ code: 'cancelled' });
  expect(sent).toEqual(['VFO:0,0,14074000;']);

  activeAbort.abort();
  await expect(active).rejects.toMatchObject({ code: 'cancelled' });
  expect(sent).toEqual(['VFO:0,0,14074000;', 'DRIVE:0,50;']);

  expect(queue.handleCommand(parseTciText('DRIVE:0,50;')[0]!)).toBe(true);
  await expect(next).resolves.toMatchObject({ reply: { name: 'drive' } });
  expect(queue.size).toBe(0);
});
