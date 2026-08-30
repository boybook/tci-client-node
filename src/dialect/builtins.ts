import type {
  TciDialect,
  TciDialectDetectionContext,
  TciDialectScore,
  TciDriveState,
  TciStreamLengthSemantics,
} from './types.js';
import { StandardTciMeterAdapter, createUnknownTciMeterAdapter } from '../meter/index.js';

type VersionTuple = readonly number[];

interface StandardDialectOptions {
  id: TciDialect['id'];
  label: string;
  streamLengthSemantics: TciStreamLengthSemantics;
  supportsStreamChannels: boolean;
  supportsTxAudioSource: boolean;
  supportsIqStream: boolean;
  iqSampleRates: readonly number[];
  driveHasTrx: boolean;
  meterAdapter?: TciDialect['meterAdapter'];
  detect: (context: TciDialectDetectionContext) => TciDialectScore;
  resolve?: (context: TciDialectDetectionContext) => TciDialect;
}

class StandardTciDialect implements TciDialect {
  readonly id: TciDialect['id'];
  readonly label: string;
  readonly streamLengthSemantics: TciStreamLengthSemantics;
  readonly supportsStreamChannels: boolean;
  readonly supportsTxAudioSource: boolean;
  readonly supportsIqStream: boolean;
  readonly iqSampleRates: readonly number[];
  readonly meterAdapter?: TciDialect['meterAdapter'];
  private readonly driveHasTrx: boolean;
  private readonly detector: StandardDialectOptions['detect'];
  private readonly resolver?: StandardDialectOptions['resolve'];

  constructor(options: StandardDialectOptions) {
    this.id = options.id;
    this.label = options.label;
    this.streamLengthSemantics = options.streamLengthSemantics;
    this.supportsStreamChannels = options.supportsStreamChannels;
    this.supportsTxAudioSource = options.supportsTxAudioSource;
    this.supportsIqStream = options.supportsIqStream;
    this.iqSampleRates = [...options.iqSampleRates];
    this.meterAdapter = options.meterAdapter;
    this.driveHasTrx = options.driveHasTrx;
    this.detector = options.detect;
    this.resolver = options.resolve;
  }

  detect(context: TciDialectDetectionContext): TciDialectScore {
    return this.detector(context);
  }

  resolve(context: TciDialectDetectionContext): TciDialect {
    return this.resolver?.(context) ?? this;
  }

  buildDriveSetArgs(trx: number, value: number): readonly unknown[] {
    return this.driveHasTrx ? [trx, value] : [value];
  }

  buildDriveReadArgs(trx: number): readonly unknown[] {
    return this.driveHasTrx ? [trx] : [];
  }

  parseDrive(args: readonly string[], defaultTrx: number): TciDriveState | undefined {
    return parseDriveState(args, defaultTrx, this.driveHasTrx);
  }

  buildTuneDriveSetArgs(trx: number, value: number): readonly unknown[] {
    return this.driveHasTrx ? [trx, value] : [value];
  }

  buildTuneDriveReadArgs(trx: number): readonly unknown[] {
    return this.driveHasTrx ? [trx] : [];
  }

  parseTuneDrive(args: readonly string[], defaultTrx: number): TciDriveState | undefined {
    return parseDriveState(args, defaultTrx, this.driveHasTrx);
  }
}

function parseDriveState(args: readonly string[], defaultTrx: number, hasTrx: boolean): TciDriveState | undefined {
  const trx = hasTrx ? Number(args[0]) : defaultTrx;
  const value = Number(args[hasTrx ? 1 : 0]);
  if (!Number.isInteger(trx) || !Number.isFinite(value)) return undefined;
  return { trx, value };
}

function version(context: TciDialectDetectionContext): VersionTuple | undefined {
  return parseTciVersion(context.identity.protocolVersion);
}

function programIncludes(context: TciDialectDetectionContext, value: string): boolean {
  return context.identity.programName?.toLowerCase().includes(value) ?? false;
}

export const expertSdr14Dialect: TciDialect = new StandardTciDialect({
  id: 'expertsdr-1.4', label: 'ExpertSDR / TCI 1.4', streamLengthSemantics: 'per-channel',
  supportsStreamChannels: false, supportsTxAudioSource: false, supportsIqStream: true,
  iqSampleRates: [48_000, 96_000, 192_000, 384_000], driveHasTrx: false,
  meterAdapter: new StandardTciMeterAdapter({ interval: { reportsApplied: false } }),
  detect: (context) => {
    const parsed = version(context);
    if (!parsed || compareTciVersion(parsed, [1, 4]) > 0) return { score: 0, evidence: [] };
    return { score: 80 + (programIncludes(context, 'expert') ? 10 : 0), evidence: [`protocol ${formatVersion(parsed)} <= 1.4`] };
  },
});

export const expertSdrLegacyDialect: TciDialect = new StandardTciDialect({
  id: 'expertsdr-1.5-1.8', label: 'ExpertSDR / TCI 1.5-1.8', streamLengthSemantics: 'per-channel',
  supportsStreamChannels: false, supportsTxAudioSource: false, supportsIqStream: true,
  iqSampleRates: [48_000, 96_000, 192_000, 384_000], driveHasTrx: true,
  meterAdapter: new StandardTciMeterAdapter({ interval: { reportsApplied: false } }),
  detect: (context) => {
    const parsed = version(context);
    if (!parsed || compareTciVersion(parsed, [1, 5]) < 0 || compareTciVersion(parsed, [1, 9]) >= 0) return { score: 0, evidence: [] };
    return { score: 80 + (programIncludes(context, 'expert') ? 10 : 0), evidence: [`protocol ${formatVersion(parsed)} is in 1.5-1.8`] };
  },
});

export const expertSdrModernDialect: TciDialect = new StandardTciDialect({
  id: 'expertsdr-1.9-2.0', label: 'ExpertSDR / TCI 1.9-2.0', streamLengthSemantics: 'scalar',
  supportsStreamChannels: true, supportsTxAudioSource: true, supportsIqStream: true,
  iqSampleRates: [48_000, 96_000, 192_000, 384_000], driveHasTrx: true,
  meterAdapter: new StandardTciMeterAdapter({ interval: { reportsApplied: false } }),
  detect: (context) => {
    const parsed = version(context);
    if (!parsed || compareTciVersion(parsed, [1, 9]) < 0) return { score: 0, evidence: [] };
    const future = compareTciVersion(parsed, [2, 0]) > 0;
    return {
      score: 70 + (programIncludes(context, 'expert') ? 15 : 0),
      evidence: [`protocol ${formatVersion(parsed)} uses modern stream negotiation`],
      warnings: future ? [`Unknown future TCI version ${formatVersion(parsed)}; using the modern dialect`] : [],
    };
  },
});

export const thetisDialect: TciDialect = new StandardTciDialect({
  id: 'thetis-2.0', label: 'Thetis / TCI 2.0', streamLengthSemantics: 'scalar',
  supportsStreamChannels: true, supportsTxAudioSource: true, supportsIqStream: true,
  iqSampleRates: [48_000, 96_000, 192_000, 384_000], driveHasTrx: true,
  meterAdapter: new StandardTciMeterAdapter({
    interval: { minMs: 30, maxMs: 1_000 },
    supportsRxExtended: true,
  }),
  detect: (context) => {
    const evidence: string[] = [];
    let score = 0;
    if (programIncludes(context, 'thetis')) { score += 120; evidence.push('PROTOCOL program is Thetis'); }
    const observed = ['tx_frequency_ex', 'tx_profiles_ex', 'tx_profile_ex', 'calibration_ex']
      .filter((name) => context.commandNames.has(name));
    if (observed.length > 0) { score += 100; evidence.push(`Thetis extension commands: ${observed.join(', ')}`); }
    if (/anan|hermes|orion|saturn/i.test(context.identity.device ?? '')) {
      score += 30;
      evidence.push(`Thetis-family device: ${context.identity.device}`);
    }
    return { score, evidence };
  },
});

export const aetherSdrDialect: TciDialect = new StandardTciDialect({
  id: 'aethersdr-1.5', label: 'AetherSDR / TCI 1.5 hybrid', streamLengthSemantics: 'scalar',
  supportsStreamChannels: true, supportsTxAudioSource: true, supportsIqStream: true,
  iqSampleRates: [24_000, 48_000, 96_000, 192_000], driveHasTrx: true,
  meterAdapter: new StandardTciMeterAdapter({
    interval: { fixedMs: 200 },
    txAlcUnit: 'dbfs',
  }),
  detect: (context) => {
    if (!/^aethersdr$/i.test(context.identity.device ?? '')) return { score: 0, evidence: [] };
    const evidence = [`AetherSDR device identity: ${context.identity.device}`];
    const modernAudioCommands = ['audio_stream_sample_type', 'audio_stream_channels', 'audio_stream_samples']
      .filter((name) => context.commandNames.has(name));
    if (modernAudioCommands.length > 0) evidence.push(`Modern audio negotiation: ${modernAudioCommands.join(', ')}`);
    return {
      score: 150,
      evidence,
      warnings: context.identity.protocolVersion === '1.5'
        ? ['AetherSDR reports TCI 1.5 but uses modern scalar audio stream semantics']
        : [],
    };
  },
});

export const genericObservedDialect: TciDialect = new StandardTciDialect({
  id: 'generic-observed', label: 'Generic observed TCI', streamLengthSemantics: 'auto',
  supportsStreamChannels: true, supportsTxAudioSource: true, supportsIqStream: false,
  iqSampleRates: [], driveHasTrx: true,
  meterAdapter: createUnknownTciMeterAdapter(),
  detect: (context) => ({
    score: context.commandNames.has('ready') ? 10 : 0,
    evidence: ['No vendor-specific match; using observed command shapes'],
    warnings: ['Dialect identity is uncertain'],
  }),
  resolve: (context) => {
    const drive = [...context.commands].reverse().find((command) => command.name === 'drive');
    const driveHasTrx = (drive?.args.length ?? 0) >= 2;
    return new StandardTciDialect({
      id: 'generic-observed',
      label: 'Generic observed TCI',
      streamLengthSemantics: 'auto',
      supportsStreamChannels: context.commandNames.has('audio_stream_channels'),
      supportsTxAudioSource: compareTciVersion(version(context) ?? [0], [2, 0]) >= 0,
      supportsIqStream: context.commandNames.has('iq_samplerate'),
      iqSampleRates: context.commandNames.has('iq_samplerate') ? [48_000] : [],
      driveHasTrx,
      meterAdapter: createUnknownTciMeterAdapter(),
      detect: genericObservedDialect.detect.bind(genericObservedDialect),
    });
  },
});

export const builtInDialects: readonly TciDialect[] = [
  aetherSdrDialect, thetisDialect, expertSdr14Dialect, expertSdrLegacyDialect, expertSdrModernDialect, genericObservedDialect,
];

export function parseTciVersion(value: string | undefined): VersionTuple | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return undefined;
  return match.slice(1).filter((part): part is string => part !== undefined).map(Number);
}

export function compareTciVersion(left: VersionTuple, right: VersionTuple): number {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function formatVersion(value: VersionTuple): string { return value.join('.'); }
