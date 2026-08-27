import type { TciCommand } from '../protocol/text.js';

export type BuiltInTciDialectId =
  | 'expertsdr-1.4'
  | 'expertsdr-1.5-1.8'
  | 'expertsdr-1.9-2.0'
  | 'aethersdr-1.5'
  | 'thetis-2.0'
  | 'generic-observed';

export type TciDialectId = BuiltInTciDialectId | (string & { readonly __tciDialectId?: never });

export type TciDialectSelection = 'auto' | TciDialectId | TciDialect;
export type TciStreamLengthSemantics = 'scalar' | 'per-channel' | 'auto';

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
