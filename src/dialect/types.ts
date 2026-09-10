import type { TciCommand } from '../protocol/text.js';
import type { TciMeterAdapter } from '../meter/index.js';
import type { TciControlAdapter } from '../controls/types.js';

export type BuiltInTciDialectId =
  | 'expertsdr-1.4'
  | 'expertsdr-1.5-1.8'
  | 'expertsdr-1.9-2.0'
  | 'expertsdr3-1.9-2.0'
  | 'aethersdr-1.5'
  | 'thetis-2.0'
  | 'generic-observed';

export type TciDialectId = BuiltInTciDialectId | (string & { readonly __tciDialectId?: never });

export type TciDialectSelection = 'auto' | TciDialectId | TciDialect;
export type TciStreamLengthSemantics = 'scalar' | 'per-channel' | 'auto';
/** How a server acknowledges a control write on its command channel. */
export type TciStateWriteAcknowledgement = 'state' | 'state-or-readback' | 'reported-state' | 'optimistic';
/** Meaning of the optional LINE_OUT_START command on a TCI server. */
export type TciLineOutStreamMode = 'native-stream' | 'vac-control' | 'unsupported' | 'unknown';

export interface TciProtocolIdentity {
  programName?: string;
  protocolVersion?: string;
  rawProtocolArgs: string[];
  device?: string;
}

export interface TciDialectDetectionContext {
  identity: TciProtocolIdentity;
  commands: readonly TciCommand[];
  commandNames: ReadonlySet<string>;
}

export interface TciDialectScore {
  score: number;
  evidence: string[];
  warnings?: string[];
}

export interface TciDriveState {
  trx: number;
  value: number;
}

export interface TciDialect {
  readonly id: TciDialectId;
  readonly label: string;
  readonly streamLengthSemantics: TciStreamLengthSemantics;
  readonly supportsStreamChannels: boolean;
  readonly supportsTxAudioSource: boolean;
  readonly supportsIqStream: boolean;
  readonly lineOutStreamMode?: TciLineOutStreamMode;
  readonly iqSampleRates: readonly number[];
  /** VFO writes may be asynchronous server events rather than command replies. */
  readonly frequencyWriteAcknowledgement?: TciStateWriteAcknowledgement;
  /** DDS notifications can carry server-side offsets (for example CW pitch). */
  readonly ddsWriteAcknowledgement?: TciStateWriteAcknowledgement;
  readonly meterAdapter?: TciMeterAdapter;
  /** Optional, explicit parameter support. Absence never implies standard controls. */
  readonly controlAdapter?: TciControlAdapter;
  detect(context: TciDialectDetectionContext): TciDialectScore;
  resolve?(context: TciDialectDetectionContext): TciDialect;
  buildDriveSetArgs(trx: number, value: number): readonly unknown[];
  buildDriveReadArgs(trx: number): readonly unknown[];
  parseDrive(args: readonly string[], defaultTrx: number): TciDriveState | undefined;
  buildTuneDriveSetArgs(trx: number, value: number): readonly unknown[];
  buildTuneDriveReadArgs(trx: number): readonly unknown[];
  parseTuneDrive(args: readonly string[], defaultTrx: number): TciDriveState | undefined;
}

export interface TciDialectDetection {
  dialect: TciDialect;
  confidence: 'manual' | 'high' | 'medium' | 'low';
  evidence: string[];
  warnings: string[];
}

export interface TciHandshakeResult {
  identity: TciProtocolIdentity;
  dialect: TciDialectDetection;
  ready: true;
  commandNames: string[];
}

export interface TciWriteResult<T> {
  requested: T;
  applied: T;
  outcome: 'applied' | 'clamped';
  acknowledgement: 'state' | 'reply' | 'readback';
}
