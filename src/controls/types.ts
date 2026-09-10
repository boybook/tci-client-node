import type { TciCommand } from '../protocol/text.js';
import type { TciProtocolIdentity } from '../dialect/types.js';

export interface TciFilterBand { lowHz: number; highHz: number }
export interface TciNoiseBlankerParameters { threshold: number; pulseLength: number }

/** Native control values. Units and addressing are declared by the selected adapter. */
export interface TciControlValueMap {
  drive: number;
  tune_drive: number;
  modulation: string;
  split_enable: boolean;
  volume: number;
  mute: boolean;
  rx_volume: number;
  rx_mute: boolean;
  rx_balance: number;
  mon_enable: boolean;
  mon_volume: number;
  agc_mode: string;
  agc_gain: number;
  sql_enable: boolean;
  sql_level: number;
  rx_nb_enable: boolean;
  rx_nb_param: TciNoiseBlankerParameters;
  rx_nb_level: number;
  rx_nr_enable: boolean;
  rx_anc_enable: boolean;
  rx_anf_enable: boolean;
  rx_apf_enable: boolean;
  rx_nf_enable: boolean;
  rx_bin_enable: boolean;
  rx_dse_enable: boolean;
  rx_filter_band: TciFilterBand;
  rit_enable: boolean;
  rit_offset: number;
  xit_enable: boolean;
  xit_offset: number;
  digl_offset: number;
  digu_offset: number;
  cw_macros_speed: number;
  cw_macros_delay: number;
  cw_keyer_speed: number;
  rx_channel_enable: boolean;
  rx_enable: boolean;
  lock: boolean;
  vfo_lock: boolean;
  tx_enable: boolean;
  tx_frequency: number;
  rx_nr_algorithm: number;
  rx_nb_algorithm: number;
  rx_step_att_enabled_ex: boolean;
  rx_step_att_ex: number;
  rx_preamp_att_ex: number;
  agc_auto_ex: boolean;
  rx_ctun_ex: boolean;
  vfo_sync_ex: boolean;
  vfo_swap_ex: null;
  fm_deviation_ex: number;
  tx_filter_band_ex: TciFilterBand;
  tx_profiles_ex: string[];
  tx_profile_ex: string;
  mic_level: number;
  tx_gain: number;
}

export type TciControlId = keyof TciControlValueMap;
export type TciControlValue = TciControlValueMap[TciControlId];
export type TciControlScope = 'global' | 'receiver' | 'trx' | 'channel';
export type TciControlTarget =
  | { scope: 'global' }
  | { scope: 'receiver'; receiver: number }
  | { scope: 'trx'; trx: number }
  | { scope: 'channel'; receiver: number; channel: number };
export interface TciControlRange { min?: number; max?: number; step?: number }

export interface TciControlDescriptor {
  id: TciControlId;
  scope: TciControlScope;
  valueType: 'boolean' | 'number' | 'enum' | 'fields' | 'list' | 'action';
  support: 'implemented' | 'unsupported' | 'unknown';
  readable: boolean;
  writable: boolean;
  updateMode: 'event' | 'polling' | 'none';
  unit?: 'dB' | 'Hz' | 'ms' | 'WPM' | 'percent' | 'native';
  range?: TciControlRange;
  fields?: Record<string, TciControlRange>;
  options?: readonly (string | number)[];
  /** Increasing the native value moves the balance to the left. */
  inverted?: boolean;
  requiresIdle?: boolean;
  /** Applied allows documented clamping; readback ignores optimistic SET echoes. */
  confirmation: 'exact' | 'applied' | 'readback' | 'sent';
  evidence: string;
  reason?: string;
}

export interface TciControlState<K extends TciControlId = TciControlId> {
  id: K;
  target: TciControlTarget;
  value: TciControlValueMap[K] | null;
  availability: 'available' | 'unavailable' | 'unknown';
  source: 'initialization' | 'broadcast' | 'readback';
  revision: number;
  updatedAt: number;
  lastError?: string;
}

export interface TciControlWriteResult<K extends TciControlId = TciControlId> {
  requested: TciControlValueMap[K];
  applied: TciControlValueMap[K] | null;
  outcome: 'applied' | 'clamped' | 'sent';
  acknowledgement: 'state' | 'readback' | 'sent';
}

export interface TciControlCommand { name: string; args: readonly unknown[] }
export interface TciControlContext {
  identity: TciProtocolIdentity;
  manual: boolean;
  receiver: number;
  trx: number;
  channel: number;
  receiverCount?: number;
  channelCount?: number;
  commandNames?: readonly string[];
  receiveOnly?: boolean;
}
export interface TciDecodedControl {
  id: TciControlId;
  target: TciControlTarget;
  value: TciControlValue;
}
export interface TciControlAdapter {
  descriptors(context: TciControlContext): readonly TciControlDescriptor[];
  decode(command: TciCommand, context: TciControlContext): readonly TciDecodedControl[];
  read(id: TciControlId, target: TciControlTarget): TciControlCommand | undefined;
  write(id: TciControlId, target: TciControlTarget, value: TciControlValue,
    getState: (id: TciControlId, target: TciControlTarget) => TciControlState | undefined): TciControlCommand;
}

export interface TciControlRequestOptions { timeoutMs?: number; signal?: AbortSignal }
