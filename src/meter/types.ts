import type { TciCommand } from '../protocol/index.js';

export type TciMeterSupport =
  | 'unknown'
  | 'declared'
  | 'acknowledged'
  | 'observed'
  | 'unsupported';

export interface TciMeterCapabilities {
  rxLevel: TciMeterSupport;
  rxAverageLevel: TciMeterSupport;
  rxPeakBin: TciMeterSupport;
  txMicLevel: TciMeterSupport;
  txRmsPower: TciMeterSupport;
  txPeakPower: TciMeterSupport;
  txSwr: TciMeterSupport;
  txAlcDbfs: TciMeterSupport;
}

export type TciRxMeterSource = 'rx_sensors' | 'rx_channel_sensors' | 'rx_channel_sensors_ex';

export interface TciRxMeterFrame {
  receiver: number;
  channel: number;
  levelDbm: number;
  averageLevelDbm?: number;
  peakBinDbm?: number;
  source: TciRxMeterSource;
  receivedAtMs: number;
  extraArgs?: readonly string[];
}

export interface TciTxMeterFrame {
  trx: number;
  micLevelDbm?: number;
  rmsPowerWatts?: number;
  peakPowerWatts?: number;
  swr?: number;
  alc?: { value: number; unit: 'dbfs' | 'percent' };
  receivedAtMs: number;
  extraArgs?: readonly string[];
}

export interface TciMeterStreamOptions {
  receiver?: number;
  channel?: number;
  trx?: number;
  rx?: boolean;
  tx?: boolean;
  intervalMs?: number;
}

export interface TciMeterInterval {
  requestedMs: number;
  appliedMs?: number;
}

export interface TciMeterCommand {
  name: string;
  args: readonly unknown[];
}

export type TciMeterDecodedFrame =
  | { kind: 'rx'; frame: TciRxMeterFrame }
  | { kind: 'tx'; frame: TciTxMeterFrame };

export interface TciMeterDecodeResult {
  decoded?: TciMeterDecodedFrame;
  issue?: string;
}

export interface TciMeterAdapter {
  readonly declaredCapabilities: TciMeterCapabilities;
  normalizeInterval(intervalMs: number): TciMeterInterval;
  buildEnableCommand(kind: 'rx' | 'tx', enabled: boolean, intervalMs: number): TciMeterCommand;
  decode(command: TciCommand, receivedAtMs: number): TciMeterDecodeResult | undefined;
}

export const UNKNOWN_TCI_METER_CAPABILITIES: TciMeterCapabilities = {
  rxLevel: 'unknown',
  rxAverageLevel: 'unknown',
  rxPeakBin: 'unknown',
  txMicLevel: 'unknown',
  txRmsPower: 'unknown',
  txPeakPower: 'unknown',
  txSwr: 'unknown',
  txAlcDbfs: 'unknown',
};

export function cloneMeterCapabilities(capabilities: TciMeterCapabilities): TciMeterCapabilities {
  return { ...capabilities };
}
