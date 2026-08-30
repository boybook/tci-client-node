import { EventEmitter } from 'eventemitter3';
import { TciError } from '../errors.js';
import type { TciCommand } from '../protocol/index.js';
import {
  cloneMeterCapabilities,
  type TciMeterAdapter,
  type TciMeterCapabilities,
  type TciMeterSupport,
  type TciRxMeterFrame,
  type TciTxMeterFrame,
} from './types.js';

const RX_COALESCE_MS = 20;

export interface TciMeterStreamEvents {
  rxFrame: (frame: TciRxMeterFrame) => void;
  txFrame: (frame: TciTxMeterFrame) => void;
  capabilitiesChanged: (capabilities: TciMeterCapabilities) => void;
  error: (error: TciError) => void;
  closed: () => void;
}

interface TciMeterStreamCallbacks {
  close: () => Promise<void>;
}

interface PendingRxFrame {
  frame: TciRxMeterFrame;
  timer: NodeJS.Timeout;
}

export class TciMeterStreamSession extends EventEmitter<TciMeterStreamEvents> {
  readonly receiver: number;
  readonly channel: number;
  readonly trx: number;
  readonly requestedIntervalMs: number;
  readonly appliedIntervalMs?: number;
  readonly rxEnabled: boolean;
  readonly txEnabled: boolean;

  private readonly adapter: TciMeterAdapter;
  private readonly callbacks: TciMeterStreamCallbacks;
  private capabilities: TciMeterCapabilities;
  private readonly pendingRx = new Map<string, PendingRxFrame>();
  private closed = false;

  constructor(options: {
    receiver: number;
    channel: number;
    trx: number;
    requestedIntervalMs: number;
    appliedIntervalMs?: number;
    rxEnabled: boolean;
    txEnabled: boolean;
    adapter: TciMeterAdapter;
    callbacks: TciMeterStreamCallbacks;
  }) {
    super();
    this.receiver = options.receiver;
    this.channel = options.channel;
    this.trx = options.trx;
    this.requestedIntervalMs = options.requestedIntervalMs;
    this.appliedIntervalMs = options.appliedIntervalMs;
    this.rxEnabled = options.rxEnabled;
    this.txEnabled = options.txEnabled;
    this.adapter = options.adapter;
    this.callbacks = options.callbacks;
    this.capabilities = cloneMeterCapabilities(options.adapter.declaredCapabilities);
  }

  getCapabilities(): TciMeterCapabilities {
    return cloneMeterCapabilities(this.capabilities);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearPendingRx();
    try {
      await this.callbacks.close();
    } finally {
      this.emit('closed');
      this.removeAllListeners();
    }
  }

  _acceptCommand(command: TciCommand, receivedAtMs: number): void {
    if (this.closed) return;
    this.acceptEnableAcknowledgement(command);
    const result = this.adapter.decode(command, receivedAtMs);
    if (!result) return;
    if (result.issue) {
      this.emit('error', new TciError('protocol-error', result.issue));
      return;
    }
    if (result.decoded?.kind === 'rx') this.acceptRxFrame(result.decoded.frame);
    if (result.decoded?.kind === 'tx') this.acceptTxFrame(result.decoded.frame);
  }

  _fail(error: TciError): void {
    if (this.closed) return;
    this.closed = true;
    this.clearPendingRx();
    this.emit('error', error);
    this.emit('closed');
    this.removeAllListeners();
  }

  private acceptRxFrame(frame: TciRxMeterFrame): void {
    if (!this.rxEnabled || frame.receiver !== this.receiver || frame.channel !== this.channel) return;
    this.observe('rxLevel');
    if (frame.averageLevelDbm !== undefined) this.observe('rxAverageLevel');
    if (frame.peakBinDbm !== undefined) this.observe('rxPeakBin');

    const key = `${frame.receiver}:${frame.channel}`;
    const pending = this.pendingRx.get(key);
    if (pending) {
      const sameReading = Math.abs(pending.frame.levelDbm - frame.levelDbm) < 0.05;
      if (sameReading && rxPriority(frame) >= rxPriority(pending.frame)) {
        clearTimeout(pending.timer);
        this.pendingRx.delete(key);
      } else if (sameReading) {
        return;
      } else {
        this.flushRx(key, pending);
      }
    }
    const timer = setTimeout(() => {
      const current = this.pendingRx.get(key);
      if (current?.frame === frame) this.flushRx(key, current);
    }, RX_COALESCE_MS);
    this.pendingRx.set(key, { frame, timer });
  }

  private acceptTxFrame(frame: TciTxMeterFrame): void {
    if (!this.txEnabled || frame.trx !== this.trx) return;
    if (frame.micLevelDbm !== undefined) this.observe('txMicLevel');
    if (frame.rmsPowerWatts !== undefined) this.observe('txRmsPower');
    if (frame.peakPowerWatts !== undefined) this.observe('txPeakPower');
    if (frame.swr !== undefined) this.observe('txSwr');
    if (frame.alc?.unit === 'dbfs') this.observe('txAlcDbfs');
    this.emit('txFrame', frame);
  }

  private acceptEnableAcknowledgement(command: TciCommand): void {
    const enabled = command.args[0]?.toLowerCase();
    if (enabled !== 'true' && enabled !== '1' && enabled !== 'on') return;
    if (command.name === 'rx_sensors_enable' && this.rxEnabled) {
      this.acknowledge(['rxLevel']);
    }
    if (command.name === 'tx_sensors_enable' && this.txEnabled) {
      this.acknowledge(['txMicLevel', 'txRmsPower', 'txPeakPower', 'txSwr']);
    }
  }

  private acknowledge(keys: Array<keyof TciMeterCapabilities>): void {
    let changed = false;
    for (const key of keys) {
      if (supportRank(this.capabilities[key]) < supportRank('acknowledged')) {
        this.capabilities[key] = 'acknowledged';
        changed = true;
      }
    }
    if (changed) this.emit('capabilitiesChanged', this.getCapabilities());
  }

  private observe(key: keyof TciMeterCapabilities): void {
    if (this.capabilities[key] === 'observed') return;
    this.capabilities[key] = 'observed';
    this.emit('capabilitiesChanged', this.getCapabilities());
  }

  private flushRx(key: string, pending: PendingRxFrame): void {
    clearTimeout(pending.timer);
    if (this.pendingRx.get(key) === pending) this.pendingRx.delete(key);
    this.emit('rxFrame', pending.frame);
  }

  private clearPendingRx(): void {
    for (const pending of this.pendingRx.values()) clearTimeout(pending.timer);
    this.pendingRx.clear();
  }
}

function rxPriority(frame: TciRxMeterFrame): number {
  if (frame.source === 'rx_channel_sensors_ex') return 3;
  if (frame.source === 'rx_channel_sensors') return 2;
  return 1;
}

function supportRank(value: TciMeterSupport): number {
  switch (value) {
    case 'unsupported': return -1;
    case 'unknown': return 0;
    case 'declared': return 1;
    case 'acknowledged': return 2;
    case 'observed': return 3;
  }
}
