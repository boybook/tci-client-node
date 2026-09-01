import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TciSampleType, TciStreamType, buildStreamFrame } from '../src/audio/index.js';
import { TciTxAudioSync } from '../src/audio/TciTxAudioSync.js';
import type { TciTxChronoRequest } from '../src/client/TciClient.js';
import { parseStreamFrame } from '../src/audio/streamFrame.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TciTxAudioSync', () => {
  it('slices burst chrono requests exactly and zero-fills tail samples', () => {
    const sync = new TciTxAudioSync({
      sampleRate: 12_000,
      channels: 1,
      sampleType: TciSampleType.FLOAT32,
      samplesPerFrame: 512,
    });
    sync.begin();
    sync.push(new Float32Array([0.1, 0.2, 0.3]));

    const first = sync.serviceChrono(makeChronoRequest(2));
    const second = sync.serviceChrono(makeChronoRequest(4));

    expect(Array.from(first.samples)).toEqual([expect.closeTo(0.1, 6), expect.closeTo(0.2, 6)]);
    expect(Array.from(second.samples)).toEqual([expect.closeTo(0.3, 6), 0, 0, 0]);
    expect(first.copiedSamples).toBe(2);
    expect(second.missingSamples).toBe(3);

    const snapshot = sync.snapshot();
    expect(snapshot.underflowFrames).toBe(1);
    expect(snapshot.underflowSamples).toBe(3);
    expect(snapshot.queuedSamples).toBe(0);
  });

  it('tracks short chrono intervals and keeps pacing hints bounded', () => {
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(100);
    const sync = new TciTxAudioSync({
      sampleRate: 12_000,
      channels: 2,
      sampleType: TciSampleType.FLOAT32,
      samplesPerFrame: 256,
      targetLeadMs: 150,
    });
    sync.begin();
    sync.push([0.1, 0.2, 0.3, 0.4]);

    now.mockReturnValueOnce(120);
    sync.serviceChrono(makeChronoRequest(2));
    now.mockReturnValueOnce(160);
    sync.serviceChrono(makeChronoRequest(2));

    const snapshot = sync.snapshot();
    expect(snapshot.frameDurationMs).toBeCloseTo((256 / 12_000) * 1000, 6);
    expect(snapshot.recommendedPumpIntervalMs).toBeGreaterThanOrEqual(4);
    expect(snapshot.recommendedPumpIntervalMs).toBeLessThanOrEqual(12);
    expect(snapshot.minChronoIntervalMs).toBe(40);
    expect(snapshot.maxChronoIntervalMs).toBe(40);
    expect(snapshot.averageChronoIntervalMs).toBe(40);
  });

  it('rejects drain waiters when the session ends', async () => {
    const sync = new TciTxAudioSync({
      sampleRate: 12_000,
      channels: 1,
      sampleType: TciSampleType.FLOAT32,
      samplesPerFrame: 512,
    });
    sync.begin();
    sync.push(new Float32Array([1, 2, 3]));

    const drain = sync.drain(250);
    sync.end('testing shutdown');

    await expect(drain).rejects.toThrow(/testing shutdown/);
    expect(sync.snapshot().queuedSamples).toBe(0);
  });

  it('exposes a stable snapshot for helper-driven pump planning', () => {
    const sync = new TciTxAudioSync({
      sampleRate: 48_000,
      channels: 1,
      sampleType: TciSampleType.FLOAT32,
      samplesPerFrame: 512,
      targetLeadMs: 200,
      minLeadMs: 80,
      maxLeadMs: 220,
    });
    const snapshot = sync.snapshot();
    expect(snapshot).toMatchObject({
      sampleRate: 48_000,
      channels: 1,
      sampleType: TciSampleType.FLOAT32,
      samplesPerFrame: 512,
      targetLeadMs: 200,
      minLeadMs: 80,
      maxLeadMs: 220,
      active: false,
    });
    expect(snapshot.recommendedPumpIntervalMs).toBeGreaterThan(0);
  });
});

function makeChronoRequest(sampleCount: number): TciTxChronoRequest {
  return {
    frame: parseStreamFrame(buildStreamFrame({
      streamType: TciStreamType.TX_CHRONO,
      sampleRate: 12_000,
      sampleType: TciSampleType.FLOAT32,
      channels: 1,
      sampleCount,
    })),
    receiver: 0,
    sampleRate: 12_000,
    channels: 1,
    sampleType: TciSampleType.FLOAT32,
    sampleCount,
    frameCount: sampleCount,
  };
}
