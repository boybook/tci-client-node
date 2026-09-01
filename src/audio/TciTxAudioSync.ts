import { performance } from 'node:perf_hooks';
import { TciSampleType } from './streamFrame.js';
import type { TciTxChronoRequest } from '../client/TciClient.js';

export interface TciTxAudioSyncConfig {
  sampleRate: number;
  channels: number;
  sampleType: TciSampleType;
  samplesPerFrame: number;
  targetLeadMs?: number;
  minLeadMs?: number;
  maxLeadMs?: number;
}

export interface TciTxAudioSyncSnapshot {
  active: boolean;
  sampleRate: number;
  channels: number;
  sampleType: TciSampleType;
  samplesPerFrame: number;
  targetLeadMs: number;
  minLeadMs: number;
  maxLeadMs: number;
  frameDurationMs: number;
  recommendedPumpIntervalMs: number;
  queuedSamples: number;
  queuedAudioMs: number;
  enqueueCount: number;
  enqueuedSamples: number;
  chronoCount: number;
  requestedSamples: number;
  copiedSamples: number;
  underflowFrames: number;
  underflowSamples: number;
  maxQueuedSamples: number;
  minQueuedSamplesBeforeChrono: number | null;
  minChronoIntervalMs: number | null;
  maxChronoIntervalMs: number;
  averageChronoIntervalMs: number | null;
  lastChronoAtMs: number | null;
}

export interface TciTxChronoServiceResult {
  samples: Float32Array;
  copiedSamples: number;
  missingSamples: number;
}

interface DrainWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface TciTxAudioSyncDiagnostics {
  startedAtMs: number;
  lastChronoAtMs: number | null;
  enqueueCount: number;
  enqueuedSamples: number;
  chronoCount: number;
  requestedSamples: number;
  copiedSamples: number;
  underflowFrames: number;
  underflowSamples: number;
  maxQueuedSamples: number;
  minQueuedSamplesBeforeChrono: number | null;
  minChronoIntervalMs: number | null;
  maxChronoIntervalMs: number;
  totalChronoIntervalMs: number;
}

const DEFAULT_TARGET_LEAD_MS = 150;
const MIN_TARGET_LEAD_MS = 120;
const MAX_TARGET_LEAD_MS = 180;

export class TciTxAudioSync {
  private readonly config: {
    sampleRate: number;
    channels: number;
    sampleType: TciSampleType;
    samplesPerFrame: number;
    targetLeadMs: number;
    minLeadMs: number;
    maxLeadMs: number;
    frameDurationMs: number;
    recommendedPumpIntervalMs: number;
  };

  private active = false;
  private queue: Float32Array[] = [];
  private queueOffset = 0;
  private queuedSamples = 0;
  private drainWaiters: DrainWaiter[] = [];
  private diagnostics: TciTxAudioSyncDiagnostics | null = null;

  constructor(config: TciTxAudioSyncConfig) {
    const sampleRate = normalizePositiveNumber(config.sampleRate, 'sampleRate');
    const channels = Math.max(1, Math.floor(config.channels || 1));
    const samplesPerFrame = Math.max(1, Math.floor(config.samplesPerFrame || 1));
    const minLeadMs = normalizeLeadMs(config.minLeadMs ?? MIN_TARGET_LEAD_MS);
    const maxLeadMs = normalizeLeadMs(config.maxLeadMs ?? MAX_TARGET_LEAD_MS);
    const targetLeadMs = clampLeadMs(config.targetLeadMs ?? DEFAULT_TARGET_LEAD_MS, minLeadMs, maxLeadMs);
    const frameDurationMs = (samplesPerFrame / sampleRate) * 1000;
    const recommendedPumpIntervalMs = Math.max(4, Math.min(12, Math.round(frameDurationMs / 4) || 4));

    this.config = {
      sampleRate,
      channels,
      sampleType: config.sampleType,
      samplesPerFrame,
      targetLeadMs,
      minLeadMs,
      maxLeadMs,
      frameDurationMs,
      recommendedPumpIntervalMs,
    };
  }

  begin(): void {
    this.rejectDrainWaiters(new Error('TCI TX audio session superseded'));
    this.queue = [];
    this.queueOffset = 0;
    this.queuedSamples = 0;
    this.active = true;
    this.diagnostics = {
      startedAtMs: performance.now(),
      lastChronoAtMs: null,
      enqueueCount: 0,
      enqueuedSamples: 0,
      chronoCount: 0,
      requestedSamples: 0,
      copiedSamples: 0,
      underflowFrames: 0,
      underflowSamples: 0,
      maxQueuedSamples: 0,
      minQueuedSamplesBeforeChrono: null,
      minChronoIntervalMs: null,
      maxChronoIntervalMs: 0,
      totalChronoIntervalMs: 0,
    };
  }

  push(samples: Float32Array | readonly number[]): void {
    if (!this.active) {
      this.begin();
    }
    const copy = samples instanceof Float32Array ? new Float32Array(samples) : Float32Array.from(samples);
    if (copy.length <= 0) {
      return;
    }
    this.queue.push(copy);
    this.queuedSamples += copy.length;
    const diagnostics = this.diagnostics;
    if (diagnostics) {
      diagnostics.enqueueCount += 1;
      diagnostics.enqueuedSamples += copy.length;
      diagnostics.maxQueuedSamples = Math.max(diagnostics.maxQueuedSamples, this.queuedSamples);
    }
  }

  serviceChrono(request: TciTxChronoRequest): TciTxChronoServiceResult {
    const requestedSamples = Math.max(0, Math.floor(request.sampleCount));
    const queuedSamplesBefore = this.queuedSamples;
    const receivedAtMs = performance.now();
    const { samples, copiedSamples } = this.dequeue(requestedSamples);
    const missingSamples = requestedSamples - copiedSamples;
    const diagnostics = this.diagnostics;
    if (diagnostics) {
      if (diagnostics.lastChronoAtMs !== null) {
        const intervalMs = receivedAtMs - diagnostics.lastChronoAtMs;
        diagnostics.totalChronoIntervalMs += intervalMs;
        diagnostics.minChronoIntervalMs = diagnostics.minChronoIntervalMs === null
          ? intervalMs
          : Math.min(diagnostics.minChronoIntervalMs, intervalMs);
        diagnostics.maxChronoIntervalMs = Math.max(diagnostics.maxChronoIntervalMs, intervalMs);
      }
      diagnostics.lastChronoAtMs = receivedAtMs;
      diagnostics.chronoCount += 1;
      diagnostics.requestedSamples += requestedSamples;
      diagnostics.copiedSamples += copiedSamples;
      diagnostics.minQueuedSamplesBeforeChrono = diagnostics.minQueuedSamplesBeforeChrono === null
        ? queuedSamplesBefore
        : Math.min(diagnostics.minQueuedSamplesBeforeChrono, queuedSamplesBefore);
      if (missingSamples > 0) {
        diagnostics.underflowFrames += 1;
        diagnostics.underflowSamples += missingSamples;
      }
    }
    return { samples, copiedSamples, missingSamples };
  }

  async drain(timeoutMs: number): Promise<void> {
    if (this.queuedSamples <= 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: DrainWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.drainWaiters = this.drainWaiters.filter((candidate) => candidate !== waiter);
          reject(new Error(`Timed out waiting for TCI TX audio drain (${this.queuedSamples} samples queued)`));
        }, Math.max(1, Math.floor(timeoutMs))),
      };
      this.drainWaiters.push(waiter);
    });
  }

  end(reason = 'TCI TX audio session ended'): void {
    if (!this.active && this.queue.length === 0 && this.drainWaiters.length === 0) {
      return;
    }
    this.active = false;
    this.queue = [];
    this.queueOffset = 0;
    this.queuedSamples = 0;
    this.rejectDrainWaiters(new Error(reason));
  }

  snapshot(): TciTxAudioSyncSnapshot {
    const diagnostics = this.diagnostics;
    const averageChronoIntervalMs = diagnostics && diagnostics.chronoCount > 1
      ? diagnostics.totalChronoIntervalMs / (diagnostics.chronoCount - 1)
      : null;
    return {
      active: this.active,
      sampleRate: this.config.sampleRate,
      channels: this.config.channels,
      sampleType: this.config.sampleType,
      samplesPerFrame: this.config.samplesPerFrame,
      targetLeadMs: this.config.targetLeadMs,
      minLeadMs: this.config.minLeadMs,
      maxLeadMs: this.config.maxLeadMs,
      frameDurationMs: this.config.frameDurationMs,
      recommendedPumpIntervalMs: this.config.recommendedPumpIntervalMs,
      queuedSamples: this.queuedSamples,
      queuedAudioMs: (this.queuedSamples / this.config.sampleRate) * 1000,
      enqueueCount: diagnostics?.enqueueCount ?? 0,
      enqueuedSamples: diagnostics?.enqueuedSamples ?? 0,
      chronoCount: diagnostics?.chronoCount ?? 0,
      requestedSamples: diagnostics?.requestedSamples ?? 0,
      copiedSamples: diagnostics?.copiedSamples ?? 0,
      underflowFrames: diagnostics?.underflowFrames ?? 0,
      underflowSamples: diagnostics?.underflowSamples ?? 0,
      maxQueuedSamples: diagnostics?.maxQueuedSamples ?? 0,
      minQueuedSamplesBeforeChrono: diagnostics?.minQueuedSamplesBeforeChrono ?? null,
      minChronoIntervalMs: diagnostics?.minChronoIntervalMs ?? null,
      maxChronoIntervalMs: diagnostics?.maxChronoIntervalMs ?? 0,
      averageChronoIntervalMs,
      lastChronoAtMs: diagnostics?.lastChronoAtMs ?? null,
    };
  }

  private dequeue(sampleCount: number): TciTxChronoServiceResult {
    const output = new Float32Array(sampleCount);
    let copiedSamples = 0;
    while (copiedSamples < output.length && this.queue.length > 0) {
      const chunk = this.queue[0]!;
      const available = chunk.length - this.queueOffset;
      const take = Math.min(output.length - copiedSamples, available);
      output.set(chunk.subarray(this.queueOffset, this.queueOffset + take), copiedSamples);
      copiedSamples += take;
      this.queueOffset += take;
      this.queuedSamples = Math.max(0, this.queuedSamples - take);
      if (this.queueOffset >= chunk.length) {
        this.queue.shift();
        this.queueOffset = 0;
      }
    }
    this.resolveDrainWaitersIfDrained();
    return { samples: output, copiedSamples, missingSamples: output.length - copiedSamples };
  }

  private resolveDrainWaitersIfDrained(): void {
    if (this.queuedSamples > 0 || this.drainWaiters.length === 0) {
      return;
    }
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private rejectDrainWaiters(error: Error): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
}

function normalizePositiveNumber(value: number, label: string): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    throw new Error(`Invalid TCI TX audio ${label}: ${value}`);
  }
  return rounded;
}

function normalizeLeadMs(value: number): number {
  const rounded = Math.round(value);
  if (!Number.isFinite(rounded) || rounded <= 0) {
    return DEFAULT_TARGET_LEAD_MS;
  }
  return rounded;
}

function clampLeadMs(value: number, minLeadMs: number, maxLeadMs: number): number {
  return Math.min(maxLeadMs, Math.max(minLeadMs, Math.round(value)));
}
