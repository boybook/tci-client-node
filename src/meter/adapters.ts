import type { TciCommand } from '../protocol/index.js';
import {
  cloneMeterCapabilities,
  UNKNOWN_TCI_METER_CAPABILITIES,
  type TciMeterAdapter,
  type TciMeterCapabilities,
  type TciMeterDecodeResult,
  type TciMeterInterval,
  type TciRxMeterFrame,
  type TciTxMeterFrame,
} from './types.js';

interface StandardTciMeterAdapterOptions {
  capabilities?: Partial<TciMeterCapabilities>;
  interval?: { minMs?: number; maxMs?: number; fixedMs?: number; reportsApplied?: boolean };
  supportsRxExtended?: boolean;
  txAlcUnit?: 'dbfs' | 'percent';
}

export class StandardTciMeterAdapter implements TciMeterAdapter {
  readonly declaredCapabilities: TciMeterCapabilities;
  private readonly options: StandardTciMeterAdapterOptions;

  constructor(options: StandardTciMeterAdapterOptions = {}) {
    this.options = options;
    this.declaredCapabilities = {
      ...UNKNOWN_TCI_METER_CAPABILITIES,
      rxLevel: 'declared',
      txMicLevel: 'declared',
      txRmsPower: 'declared',
      txPeakPower: 'declared',
      txSwr: 'declared',
      rxAverageLevel: options.supportsRxExtended ? 'declared' : 'unknown',
      rxPeakBin: options.supportsRxExtended ? 'declared' : 'unknown',
      txAlcDbfs: options.txAlcUnit === 'dbfs' ? 'declared' : 'unknown',
      ...options.capabilities,
    };
  }

  normalizeInterval(intervalMs: number): TciMeterInterval {
    const requestedMs = Math.round(intervalMs);
    if (this.options.interval?.fixedMs !== undefined) {
      return { requestedMs, appliedMs: this.options.interval.fixedMs };
    }
    const minMs = this.options.interval?.minMs ?? requestedMs;
    const maxMs = this.options.interval?.maxMs ?? requestedMs;
    const normalized = Math.max(minMs, Math.min(maxMs, requestedMs));
    return {
      requestedMs,
      appliedMs: this.options.interval?.reportsApplied === false ? undefined : normalized,
    };
  }

  buildEnableCommand(kind: 'rx' | 'tx', enabled: boolean, intervalMs: number) {
    return {
      name: kind === 'rx' ? 'RX_SENSORS_ENABLE' : 'TX_SENSORS_ENABLE',
      args: enabled ? [true, intervalMs] : [false],
    };
  }

  decode(command: TciCommand, receivedAtMs: number): TciMeterDecodeResult | undefined {
    switch (command.name) {
      case 'rx_sensors':
        return decodeRx(command, receivedAtMs, 'rx_sensors');
      case 'rx_channel_sensors':
        return decodeRx(command, receivedAtMs, 'rx_channel_sensors');
      case 'rx_channel_sensors_ex':
        return decodeRx(command, receivedAtMs, 'rx_channel_sensors_ex');
      case 'tx_sensors':
        return decodeTx(command, receivedAtMs, this.options.txAlcUnit);
      default:
        return undefined;
    }
  }
}

export function createUnknownTciMeterAdapter(): TciMeterAdapter {
  return new StandardTciMeterAdapter({
    capabilities: cloneMeterCapabilities(UNKNOWN_TCI_METER_CAPABILITIES),
    interval: { reportsApplied: false },
  });
}

function decodeRx(
  command: TciCommand,
  receivedAtMs: number,
  source: TciRxMeterFrame['source'],
): TciMeterDecodeResult {
  const receiver = integer(command.args[0]);
  const hasChannel = source !== 'rx_sensors';
  const channel = hasChannel ? integer(command.args[1]) : 0;
  const levelIndex = hasChannel ? 2 : 1;
  const levelDbm = finite(command.args[levelIndex]);
  if (receiver === undefined || receiver < 0 || channel === undefined || channel < 0 || levelDbm === undefined) {
    return { issue: `Invalid ${command.originalName} meter frame: ${command.raw}` };
  }

  const frame: TciRxMeterFrame = { receiver, channel, levelDbm, source, receivedAtMs };
  if (source === 'rx_channel_sensors_ex') {
    const averageLevelDbm = finite(command.args[3]);
    const peakBinDbm = finite(command.args[4]);
    if (averageLevelDbm === undefined || peakBinDbm === undefined) {
      return { issue: `Invalid ${command.originalName} extended meter frame: ${command.raw}` };
    }
    frame.averageLevelDbm = averageLevelDbm;
    frame.peakBinDbm = peakBinDbm;
    if (command.args.length > 5) frame.extraArgs = command.args.slice(5);
  } else if (command.args.length > levelIndex + 1) {
    frame.extraArgs = command.args.slice(levelIndex + 1);
  }
  return { decoded: { kind: 'rx', frame } };
}

function decodeTx(
  command: TciCommand,
  receivedAtMs: number,
  alcUnit?: 'dbfs' | 'percent',
): TciMeterDecodeResult {
  const trx = integer(command.args[0]);
  if (trx === undefined || trx < 0) {
    return { issue: `Invalid ${command.originalName} transmitter index: ${command.raw}` };
  }

  const micLevelDbm = optionalFinite(command.args[1]);
  const rmsPowerWatts = optionalFinite(command.args[2]);
  const peakPowerWatts = optionalFinite(command.args[3]);
  const swr = optionalFinite(command.args[4]);
  const alcValue = alcUnit ? optionalFinite(command.args[5]) : undefined;
  if (micLevelDbm.invalid || rmsPowerWatts.invalid || peakPowerWatts.invalid || swr.invalid || alcValue?.invalid) {
    return { issue: `Invalid ${command.originalName} numeric meter frame: ${command.raw}` };
  }
  if ((rmsPowerWatts.value !== undefined && rmsPowerWatts.value < 0)
    || (peakPowerWatts.value !== undefined && peakPowerWatts.value < 0)
    || (swr.value !== undefined && swr.value < 1)) {
    return { issue: `Out-of-range ${command.originalName} meter frame: ${command.raw}` };
  }
  if (micLevelDbm.value === undefined && rmsPowerWatts.value === undefined
    && peakPowerWatts.value === undefined && swr.value === undefined && alcValue?.value === undefined) {
    return { issue: `Empty ${command.originalName} meter frame: ${command.raw}` };
  }

  const frame: TciTxMeterFrame = {
    trx,
    micLevelDbm: micLevelDbm.value,
    rmsPowerWatts: rmsPowerWatts.value,
    peakPowerWatts: peakPowerWatts.value,
    swr: swr.value,
    receivedAtMs,
  };
  if (alcUnit && alcValue?.value !== undefined) frame.alc = { value: alcValue.value, unit: alcUnit };
  const knownArgs = alcUnit ? 6 : 5;
  if (command.args.length > knownArgs) frame.extraArgs = command.args.slice(knownArgs);
  return { decoded: { kind: 'tx', frame } };
}

function finite(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function integer(value: string | undefined): number | undefined {
  const parsed = finite(value);
  return parsed !== undefined && Number.isInteger(parsed) ? parsed : undefined;
}

function optionalFinite(value: string | undefined): { value?: number; invalid: boolean } {
  if (value === undefined || value === '') return { invalid: false };
  const parsed = Number(value);
  return Number.isFinite(parsed) ? { value: parsed, invalid: false } : { invalid: true };
}
