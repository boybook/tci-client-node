import type { TciCommand } from '../protocol/text.js';
import type {
  TciControlAdapter, TciControlCommand, TciControlContext, TciControlDescriptor,
  TciControlId, TciControlScope, TciControlState, TciControlTarget, TciControlValue,
  TciDecodedControl,
} from './types.js';

const SPEC = 'ExpertSDR3 TCI 2.0, 2024-01-12, pp.14-29,40';
const THETIS = 'ramdor/Thetis 852bf0e TCIServer.cs';
const AETHER = 'aethersdr/AetherSDR 8a358c5 TciProtocol.cpp';
const TRANSMITTER_CONTROLS = new Set<TciControlId>(['drive', 'tune_drive', 'split_enable',
  'mon_enable', 'mon_volume', 'xit_enable', 'xit_offset', 'cw_macros_speed', 'cw_macros_delay',
  'cw_keyer_speed', 'tx_filter_band_ex', 'tx_profiles_ex', 'tx_profile_ex', 'mic_level', 'tx_gain']);
type Address = TciControlScope | 'legacy-trx' | 'shared-receiver';
interface Definition extends TciControlDescriptor {
  command?: string;
  address?: Address;
  aliases?: string[];
  readCommand?: string;
  decodeValue?: (values: string[], command: string) => TciControlValue | undefined;
  encodeValue?: (value: TciControlValue, target: TciControlTarget,
    getState: (id: TciControlId, target: TciControlTarget) => TciControlState | undefined) => readonly unknown[];
}

const def = (id: TciControlId, scope: TciControlScope, valueType: Definition['valueType'],
  extra: Partial<Definition> = {}): Definition => ({
  id, scope, valueType, support: 'implemented', readable: true, writable: true,
  updateMode: 'event', confirmation: 'exact', evidence: SPEC, ...extra,
});
const number = (id: TciControlId, scope: TciControlScope, unit: Definition['unit'],
  min?: number, max?: number, extra: Partial<Definition> = {}) =>
  def(id, scope, 'number', { unit, range: { min, max, step: unit === 'dB' ? undefined : 1 }, confirmation: 'applied', ...extra });
const bool = (id: TciControlId, scope: TciControlScope = 'receiver', extra: Partial<Definition> = {}) =>
  def(id, scope, 'boolean', extra);

function standardDefinitions(): Definition[] {
  return [
    number('drive', 'trx', 'percent', 0, 100),
    number('tune_drive', 'trx', 'percent', 0, 100),
    def('modulation', 'receiver', 'enum', { requiresIdle: true, decodeValue: (values) => values.length === 1 && values[0] ? values[0].toLowerCase() : undefined }),
    bool('split_enable', 'trx', { requiresIdle: true }),
    number('volume', 'global', 'dB', -60, 0), bool('mute', 'global'),
    number('rx_volume', 'channel', 'dB', -60, 0), bool('rx_mute'),
    number('rx_balance', 'channel', 'dB', -40, 40, { inverted: true }),
    bool('mon_enable', 'global'), number('mon_volume', 'global', 'dB', -60, 0),
    def('agc_mode', 'receiver', 'enum', { options: ['normal', 'fast', 'off'], decodeValue: (values) => values.length === 1 && values[0] ? values[0].toLowerCase() : undefined }),
    number('agc_gain', 'receiver', 'dB', -20, 120),
    bool('sql_enable'), number('sql_level', 'receiver', 'dB', -140, 0),
    bool('rx_nb_enable'),
    def('rx_nb_param', 'receiver', 'fields', {
      fields: { threshold: { min: 1, max: 100, step: 1 }, pulseLength: { min: 1, max: 300, step: 1 } },
      confirmation: 'applied',
    }),
    ...(['rx_nr_enable', 'rx_anc_enable', 'rx_anf_enable', 'rx_apf_enable', 'rx_nf_enable',
      'rx_bin_enable', 'rx_dse_enable'] as const).map((id) => bool(id)),
    def('rx_filter_band', 'receiver', 'fields', {
      unit: 'Hz', fields: { lowHz: { step: 1 }, highHz: { step: 1 } }, confirmation: 'applied',
    }),
    bool('rit_enable', 'receiver', { requiresIdle: true }),
    number('rit_offset', 'receiver', 'Hz', undefined, undefined, { requiresIdle: true }),
    bool('xit_enable', 'receiver', { requiresIdle: true }),
    number('xit_offset', 'receiver', 'Hz', undefined, undefined, { requiresIdle: true }),
    number('digl_offset', 'global', 'Hz', 0, 4000, { requiresIdle: true }),
    number('digu_offset', 'global', 'Hz', 0, 4000, { requiresIdle: true }),
    number('cw_macros_speed', 'global', 'WPM', 1),
    number('cw_macros_delay', 'global', 'ms', 0),
    number('cw_keyer_speed', 'global', 'WPM', 1, undefined, {
      readable: false, confirmation: 'sent', updateMode: 'none',
    }),
    bool('rx_channel_enable', 'channel', { requiresIdle: true }),
    bool('rx_enable', 'receiver', { requiresIdle: true, evidence: 'ExpertSDR3 1.1.7 startup capture in Thetis 852bf0e; ftl/tci client' }),
    bool('lock'),
    bool('vfo_lock', 'channel', { writable: false, readable: false }),
    bool('tx_enable', 'trx', { writable: false, readable: false }),
    number('tx_frequency', 'global', 'Hz', 0, undefined, { writable: false, readable: false }),
  ];
}

const extensions: Definition[] = [
  number('rx_nb_level', 'receiver', 'percent', 0, 100),
  def('rx_nr_algorithm', 'receiver', 'enum', { options: [0, 1, 2, 3, 4] }),
  def('rx_nb_algorithm', 'receiver', 'enum', { options: [0, 1, 2] }),
  bool('rx_step_att_enabled_ex'),
  number('rx_step_att_ex', 'receiver', 'dB', 0, undefined, { writable: false, reason: 'Hardware-specific maximum is not advertised' }),
  number('rx_preamp_att_ex', 'receiver', 'dB', undefined, undefined, { writable: false, reason: 'Hardware-specific discrete settings are not advertised' }),
  bool('agc_auto_ex'), bool('rx_ctun_ex', 'receiver', { requiresIdle: true }),
  bool('vfo_sync_ex', 'global', { requiresIdle: true }),
  def('vfo_swap_ex', 'global', 'action', { readable: false, updateMode: 'none', confirmation: 'sent', requiresIdle: true }),
  def('fm_deviation_ex', 'global', 'enum', { address: 'shared-receiver', options: [2500, 5000], unit: 'Hz', requiresIdle: true }),
  def('tx_filter_band_ex', 'global', 'fields', { unit: 'Hz',
    fields: { lowHz: { min: 0, step: 1 }, highHz: { min: 100, step: 1 } }, confirmation: 'applied', requiresIdle: true }),
  def('tx_profiles_ex', 'global', 'list', { writable: false, updateMode: 'polling' }),
  def('tx_profile_ex', 'global', 'enum', { options: [], requiresIdle: true }),
  number('mic_level', 'global', 'percent', 0, 100),
  number('tx_gain', 'global', 'percent', 0, 100, { requiresIdle: true }),
];

const parseNumber = (value: string | undefined): number | undefined => {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const parseBool = (value: string | undefined): boolean | undefined =>
  value?.toLowerCase() === 'true' ? true : value?.toLowerCase() === 'false' ? false : undefined;

function decodeValue(d: Definition, values: string[], command: string): TciControlValue | undefined {
  if (d.decodeValue) return d.decodeValue(values, command);
  switch (d.valueType) {
    case 'boolean': return values.length === 1 ? parseBool(values[0]) : undefined;
    case 'number': return values.length === 1 ? parseNumber(values[0]) : undefined;
    case 'enum':
      if (values.length !== 1 || !values[0]) return undefined;
      return d.options?.some((v) => typeof v === 'number') ? parseNumber(values[0]) : values[0];
    case 'list': return values.length === 1 && values[0] === '' ? [] : [...values];
    case 'fields': {
      const keys = Object.keys(d.fields ?? {});
      if (values.length !== keys.length) return undefined;
      const parsed = values.map(parseNumber);
      if (parsed.some((v) => v === undefined)) return undefined;
      const result = Object.fromEntries(keys.map((key, i) => [key, parsed[i]!])) as unknown as TciControlValue;
      if ('lowHz' in (result as object)) {
        const band = result as { lowHz: number; highHz: number };
        if (band.lowHz >= band.highHz) return undefined;
      }
      return result;
    }
    default: return undefined;
  }
}

function addressArgs(address: Address, target: TciControlTarget): number[] {
  if (address === 'legacy-trx' || address === 'global') return [];
  if (address === 'shared-receiver') return [0];
  if (target.scope === 'receiver') return [target.receiver];
  if (target.scope === 'trx') return [target.trx];
  if (target.scope === 'channel') return [target.receiver, target.channel];
  return [];
}

function targetFromArgs(address: Address, args: string[], ctx: TciControlContext): { target: TciControlTarget; offset: number } | undefined {
  if (address === 'global') return { target: { scope: 'global' }, offset: 0 };
  if (address === 'legacy-trx') return { target: { scope: 'trx', trx: ctx.trx }, offset: 0 };
  const first = parseNumber(args[0]);
  if (first === undefined || !Number.isInteger(first) || first < 0 || first >= (ctx.receiverCount ?? 64)) return undefined;
  if (address === 'shared-receiver') return { target: { scope: 'global' }, offset: 1 };
  if (address === 'trx') return { target: { scope: 'trx', trx: first }, offset: 1 };
  if (address === 'receiver') return { target: { scope: 'receiver', receiver: first }, offset: 1 };
  const channel = parseNumber(args[1]);
  if (channel === undefined || !Number.isInteger(channel) || channel < 0 || channel >= (ctx.channelCount ?? 64)) return undefined;
  return { target: { scope: 'channel', receiver: first, channel }, offset: 2 };
}

/** Explicit vendor command tables; unknown identities never acquire control support by echoing. */
export function createTciControlAdapter(flavor: 'expert' | 'thetis' | 'aether', legacyDrive = false): TciControlAdapter {
  const definitions = new Map<TciControlId, Definition>();
  for (const d of standardDefinitions()) definitions.set(d.id, d);
  for (const d of extensions) definitions.set(d.id, { ...d, support: 'unsupported', readable: false, writable: false,
    reason: 'Not defined by this dialect' });
  const patch = (id: TciControlId, changes: Partial<Definition>) => definitions.set(id, { ...definitions.get(id)!, ...changes });
  const enable = (id: TciControlId, changes: Partial<Definition> = {}) => {
    const d = extensions.find((item) => item.id === id)!;
    definitions.set(id, { ...d, evidence: flavor === 'thetis' ? THETIS : AETHER, ...changes });
  };
  if (legacyDrive) for (const id of ['drive', 'tune_drive'] as const) patch(id, { address: 'legacy-trx' });

  if (flavor === 'thetis') {
    for (const d of definitions.values()) d.evidence = THETIS;
    patch('agc_mode', { options: ['off', 'long', 'slow', 'normal', 'fast', 'custom'] });
    patch('agc_gain', { range: { min: -20, max: 120, step: 1 } });
    patch('sql_level', { range: { min: -140, max: 0, step: 1 } });
    patch('volume', { range: { min: -60, max: 0, step: 0.6 } });
    patch('mon_volume', { range: { min: -60, max: 0, step: 0.6 } });
    patch('rx_balance', { range: { min: -40, max: 40, step: 0.8 } });
    patch('rx_nf_enable', { writable: false,
      reason: 'Thetis queries receiver MNF but writes global TNF; independent receiver writes are not supported' });
    patch('cw_keyer_speed', { readable: true, updateMode: 'event', confirmation: 'applied' });
    for (const id of ['rit_enable', 'rit_offset', 'xit_enable', 'xit_offset'] as const) patch(id, { scope: 'global', address: 'shared-receiver' });
    for (const id of ['rx_anc_enable', 'rx_dse_enable', 'rx_nb_param'] as const) patch(id, {
      support: 'unsupported', readable: false, writable: false, reason: 'No Thetis handler for this command',
    });
    for (const id of ['rx_step_att_enabled_ex', 'rx_step_att_ex', 'rx_preamp_att_ex', 'agc_auto_ex',
      'rx_ctun_ex', 'vfo_sync_ex', 'vfo_swap_ex', 'fm_deviation_ex', 'tx_filter_band_ex',
      'tx_profiles_ex', 'tx_profile_ex'] as const) enable(id);
    for (const [enabledId, algorithmId, command] of [
      ['rx_nr_enable', 'rx_nr_algorithm', 'rx_nr_enable_ex'],
      ['rx_nb_enable', 'rx_nb_algorithm', 'rx_nb_enable_ex'],
    ] as const) {
      patch(enabledId, {
        command, readCommand: enabledId, aliases: [enabledId],
        decodeValue: (values) => values.length === 1 || values.length === 2 ? parseBool(values[0]) : undefined,
        encodeValue: (value, target, get) => {
          const selected = get(algorithmId, target)?.value;
          return [value, value ? (typeof selected === 'number' && selected > 0 ? selected : 1) : 0];
        },
      });
      enable(algorithmId, { command, readCommand: enabledId,
        decodeValue: (values) => values.length === 2 && parseBool(values[0]) !== undefined ? parseNumber(values[1]) : undefined,
        encodeValue: (value) => [Number(value) > 0, value],
      });
    }
  }

  if (flavor === 'aether') {
    for (const d of definitions.values()) d.evidence = AETHER;
    // These handlers do not drive DSP. Even perfect SET/GET round trips prove nothing.
    for (const id of ['rx_bin_enable', 'rx_anc_enable', 'rx_dse_enable', 'rx_nf_enable'] as const) patch(id, {
      support: 'unsupported', readable: false, writable: false, reason: 'Server stores this value without applying DSP',
    });
    patch('mute', { scope: 'receiver' });
    patch('rx_volume', { scope: 'receiver', unit: 'percent', range: { min: 0, max: 100, step: 1 } });
    patch('rx_balance', { scope: 'receiver', unit: 'native', range: { min: -50, max: 50, step: 1 }, inverted: false });
    patch('mon_volume', { unit: 'percent', range: { min: 0, max: 100, step: 1 } });
    patch('agc_mode', { options: ['off', 'slow', 'med', 'fast'] });
    for (const id of ['agc_gain', 'sql_level'] as const) patch(id, {
      unit: 'native', range: undefined, writable: false, reason: 'Underlying receiver range is not advertised',
    });
    patch('rx_nb_param', { support: 'unsupported', readable: false, writable: false, reason: 'Aether exposes NB level, not the standard parameter pair' });
    enable('rx_nb_level', { command: 'rx_nb_param', confirmation: 'readback',
      decodeValue: (values) => values.length === 2 && values[0] === '0' ? parseNumber(values[1]) : undefined,
      encodeValue: (value) => [0, value],
    });
    patch('rx_channel_enable', { scope: 'receiver', writable: false });
    patch('rx_enable', { readable: false, writable: false });
    patch('vfo_lock', { support: 'unsupported', readable: false, writable: false, reason: 'Alias has incompatible channel addressing' });
    patch('cw_keyer_speed', { readable: true, range: { min: 5, max: 100, step: 1 } });
    enable('mic_level'); enable('tx_gain');
    // The server may echo the requested value before its queued model setter applies it.
    for (const d of definitions.values()) {
      if (d.readable && d.writable) d.confirmation = 'readback';
      if (d.support === 'implemented' && d.readable) d.updateMode = 'polling';
    }
  }

  const commands = new Map<string, Definition[]>();
  for (const d of definitions.values()) {
    for (const name of [d.command ?? d.id, ...(d.aliases ?? [])]) {
      const bucket = commands.get(name) ?? [];
      bucket.push(d); commands.set(name, bucket);
    }
  }
  return {
    descriptors(ctx) {
      const verifiedIdentity = ctx.manual || (flavor === 'expert'
        ? /sunsdr|colibri|^mb1\b|expert/i.test(ctx.identity.device ?? '')
        : flavor === 'thetis' ? /thetis/i.test(ctx.identity.programName ?? '')
          || ['tx_profiles_ex', 'tx_profile_ex', 'calibration_ex'].every((name) => ctx.commandNames?.includes(name))
          : /^aethersdr$/i.test(ctx.identity.device ?? ''));
      const version = (ctx.identity.protocolVersion ?? '').split('.').map(Number);
      return [...definitions.values()].map((d) => {
        const { command: _command, address: _address, aliases: _aliases, readCommand: _read,
          decodeValue: _decode, encodeValue: _encode, ...descriptor } = d;
        if (!verifiedIdentity) return { ...descriptor, support: 'unknown', readable: false, writable: false,
          reason: 'Control implementation cannot be verified from this server identity' };
        if (ctx.receiveOnly === true && TRANSMITTER_CONTROLS.has(d.id)) return {
          ...descriptor, support: 'unsupported', readable: false, writable: false, reason: 'Device declares receive-only operation',
        };
        // The available legacy evidence is the ExpertSDR 1.8 capture; do not guess earlier tables.
        if (flavor === 'expert' && (version[0] ?? 0) < 2 && (version[1] ?? 0) < 8
          && !['drive', 'tune_drive', 'modulation', 'split_enable', 'rx_filter_band', 'mon_enable', 'mon_volume'].includes(d.id)) {
          return { ...descriptor, support: 'unknown', readable: false, writable: false, reason: 'No control evidence for this legacy version' };
        }
        if (flavor === 'expert' && d.id === 'vfo_lock' && (version[0] ?? 0) < 2) return {
          ...descriptor, support: 'unsupported', readable: false, writable: false, reason: 'Requires TCI 2.0',
        };
        return descriptor;
      });
    },
    decode(command, ctx) {
      const decoded: TciDecodedControl[] = [];
      for (const d of commands.get(command.name) ?? []) {
        const addressed = targetFromArgs(d.address ?? d.scope, command.args, ctx);
        if (!addressed) continue;
        const value = decodeValue(d, command.args.slice(addressed.offset), command.name);
        if (value !== undefined) decoded.push({ id: d.id, target: addressed.target, value });
      }
      return decoded;
    },
    read(id, target) {
      const d = definitions.get(id);
      if (!d?.readable) return undefined;
      return { name: d.readCommand ?? d.command ?? id, args: addressArgs(d.address ?? d.scope, target) };
    },
    write(id, target, value, getState): TciControlCommand {
      const d = definitions.get(id)!;
      const values = d.encodeValue ? d.encodeValue(value, target, getState)
        : d.valueType === 'fields' ? Object.keys(d.fields!).map((key) => (value as unknown as Record<string, number>)[key])
          : d.valueType === 'action' ? [] : [value];
      return { name: d.command ?? id, args: [...addressArgs(d.address ?? d.scope, target), ...values] };
    },
  };
}
