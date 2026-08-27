import { EventEmitter } from 'eventemitter3';
import WebSocket from 'ws';
import { TciError, toTciError } from '../errors.js';
import {
  buildTxAudioFrame,
  normalizeSampleType,
  parseStreamFrame,
  sampleTypeName,
  TciSampleType,
  TciStreamType,
  type BuildTxAudioFrameOptions,
  type TciSampleTypeName,
  type TciStreamFrame,
} from '../audio/streamFrame.js';
import {
  formatTciCommand,
  parseTciText,
  TciCommandQueue,
  type QueueCommandOptions,
  type TciCommand,
} from '../protocol/index.js';
import {
  assertValidTciHandshake,
  defaultTciDialectRegistry,
  parseProtocolIdentity,
  type TciDialect,
  type TciDialectId,
  type TciDialectRegistry,
  type TciDialectSelection,
  type TciHandshakeResult,
  type TciWriteResult,
} from '../dialect/index.js';
import {
  WebSocketTciTransport,
  type TciTransport,
  type TciTransportFactory,
} from '../transport/index.js';

export interface TciClientOptions {
  url: string;
  receiver?: number;
  trx?: number;
  vfo?: number;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  commandTimeoutMs?: number;
  writeAckMode?: TciWriteAckMode;
  writeTimeoutMs?: number;
  writeSettleMs?: number;
  frequencyWriteSettleMs?: number;
  dialect?: TciDialectSelection;
  dialectRegistry?: TciDialectRegistry;
  WebSocketImpl?: typeof WebSocket;
  transportFactory?: TciTransportFactory;
}

export interface TciAudioConfig {
  sampleRate: 8_000 | 12_000 | 24_000 | 48_000 | number;
  sampleType?: TciSampleType | TciSampleTypeName;
  channels?: 1 | 2 | number;
  samplesPerFrame?: number;
  txBufferingMs?: number;
}

export interface TciPttOptions {
  source?: 'tci' | 'mic1' | 'mic2' | 'micpc' | 'ecoder2' | string;
  trx?: number;
  ackMode?: TciWriteAckMode;
  timeoutMs?: number;
  settleMs?: number;
}

export type TciWriteAckMode = 'state' | 'reply' | 'optimistic';

export interface TciWriteOptions {
  ackMode?: TciWriteAckMode;
  timeoutMs?: number;
  settleMs?: number;
}

export interface TciTxChronoRequest {
  frame: TciStreamFrame;
  receiver: number;
  sampleRate: number;
  channels: number;
  sampleType: TciSampleType;
  sampleCount: number;
  frameCount: number;
}

export interface TciClientState {
  connected: boolean;
  ready: boolean;
  protocol?: string;
  protocolName?: string;
  protocolVersion?: string;
  dialectId?: TciDialectId;
  dialectConfidence?: TciHandshakeResult['dialect']['confidence'];
  dialectWarnings: string[];
  device?: string;
  receiveOnly?: boolean;
  trxCount?: number;
  channelCount?: number;
  vfoLimits?: [number, number];
  ifLimits?: [number, number];
  modulations: string[];
  frequencies: Record<string, number>;
  modes: Record<string, string>;
  ptt: Record<string, boolean>;
  pttSource: Record<string, string | undefined>;
  tune: Record<string, boolean>;
  drive: Record<string, number>;
  tuneDrive: Record<string, number>;
  split: Record<string, boolean>;
  rxSensors: Record<string, Record<string, number | string | boolean>>;
  txSensors: Record<string, Record<string, number | string | boolean>>;
  audio?: Required<Pick<TciAudioConfig, 'sampleRate' | 'channels' | 'sampleType' | 'samplesPerFrame'>> & {
    txBufferingMs?: number;
    running: boolean;
  };
}

export interface TciClientEvents {
  connected: () => void;
  disconnected: (reason?: unknown) => void;
  ready: (state: TciClientState) => void;
  handshake: (result: TciHandshakeResult) => void;
  state: (state: TciClientState) => void;
  command: (command: TciCommand) => void;
  binary: (frame: TciStreamFrame) => void;
  'tci:tx': (raw: string) => void;
  'tci:rx': (raw: string, commands: TciCommand[]) => void;
  'tci:binary': (frame: TciStreamFrame) => void;
  rxAudioFrame: (frame: TciStreamFrame) => void;
  lineoutAudioFrame: (frame: TciStreamFrame) => void;
  txChrono: (request: TciTxChronoRequest) => void;
  error: (error: TciError) => void;
}

export interface SendCommandOptions extends QueueCommandOptions {
  waitForReply?: boolean;
}

export class TciClient extends EventEmitter<TciClientEvents> {
  readonly options: Required<Pick<
    TciClientOptions,
    | 'receiver'
    | 'trx'
    | 'vfo'
    | 'connectTimeoutMs'
    | 'handshakeTimeoutMs'
    | 'commandTimeoutMs'
    | 'writeAckMode'
    | 'writeTimeoutMs'
    | 'writeSettleMs'
    | 'frequencyWriteSettleMs'
  >> &
    Pick<TciClientOptions, 'url'> & { dialect: TciDialectSelection };

  private readonly WebSocketImpl: typeof WebSocket;
  private readonly transportFactory: TciTransportFactory;
  private transport?: TciTransport;
  private readonly queue: TciCommandQueue;
  private readonly state: TciClientState;
  private readonly stateReducers: Map<string, (args: string[]) => void>;
  private readonly dialectRegistry: TciDialectRegistry;
  private activeDialect?: TciDialect;
  private handshakeResult?: TciHandshakeResult;
  private handshakeError?: TciError;
  private initializationCommands: TciCommand[] = [];
  private handshakeWaiter?: {
    resolve: (result: TciHandshakeResult) => void;
    reject: (error: TciError) => void;
    timer: NodeJS.Timeout;
  };

  constructor(options: TciClientOptions) {
    super();
    this.options = {
      url: options.url,
      receiver: options.receiver ?? 0,
      trx: options.trx ?? 0,
      vfo: options.vfo ?? 0,
      connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 10_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 1_000,
      writeAckMode: options.writeAckMode ?? 'state',
      writeTimeoutMs: options.writeTimeoutMs ?? 3_000,
      writeSettleMs: options.writeSettleMs ?? 0,
      frequencyWriteSettleMs: options.frequencyWriteSettleMs ?? 250,
      dialect: options.dialect ?? 'auto',
    };
    this.dialectRegistry = options.dialectRegistry ?? defaultTciDialectRegistry;
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.transportFactory = options.transportFactory
      ?? ((url) => new WebSocketTciTransport(url, this.WebSocketImpl));
    this.queue = new TciCommandQueue({
      timeoutMs: this.options.commandTimeoutMs,
      send: (raw) => this.sendRaw(raw),
    });
    this.queue.setConnected(false);
    this.state = {
      connected: false,
      ready: false,
      modulations: [],
      frequencies: {},
      modes: {},
      ptt: {},
      pttSource: {},
      tune: {},
      drive: {},
      tuneDrive: {},
      split: {},
      dialectWarnings: [],
      rxSensors: {},
      txSensors: {},
    };
    this.stateReducers = this.createStateReducers();
  }

  async connect(): Promise<TciHandshakeResult> {
    if (this.transport?.isConnected()) {
      return this.handshakeResult ?? this.waitForHandshake();
    }
    this.resetHandshake();
    const transport = this.transportFactory(this.options.url);
    this.transport = transport;
    this.attachTransport(transport);
    await transport.connect(this.options.connectTimeoutMs);
    this.state.connected = true;
    this.queue.setConnected(true);
    this.emit('connected');
    this.emitState();
    try {
      return await this.waitForHandshake();
    } catch (error) {
      transport.terminate();
      throw error;
    }
  }

  async disconnect(code = 1000, reason = 'client disconnect'): Promise<void> {
    const transport = this.transport;
    if (!transport) return;
    await transport.disconnect(code, reason);
    this.handleClose();
  }

  isConnected(): boolean {
    return this.transport?.isConnected() ?? false;
  }

  getState(): TciClientState {
    return cloneState(this.state);
  }

  getHandshakeResult(): TciHandshakeResult | undefined {
    return this.handshakeResult ? cloneHandshake(this.handshakeResult) : undefined;
  }

  async sendCommand(name: string, args: readonly unknown[] = [], options: SendCommandOptions = {}): Promise<TciCommand | undefined> {
    const raw = formatTciCommand(name, args);
    if (options.waitForReply === false) {
      await this.sendRaw(raw);
      return undefined;
    }
    const result = await this.queue.enqueue(raw, options);
    return result.reply;
  }

  async request(name: string, args: readonly unknown[] = [], options: QueueCommandOptions = {}): Promise<TciCommand> {
    const reply = await this.sendCommand(name, args, { ...options, waitForReply: true });
    if (!reply) {
      throw new TciError('protocol-error', `No reply for ${name}`);
    }
    return reply;
  }

  async sendStateWrite(
    name: string,
    args: readonly unknown[],
    isApplied: (state: TciClientState) => boolean,
    description = formatTciCommand(name, args).replace(/;$/, ''),
    options: TciWriteOptions = {},
  ): Promise<void> {
    const ackMode = options.ackMode ?? this.options.writeAckMode;
    if (ackMode === 'reply') {
      await this.sendCommand(name, args, { timeoutMs: options.timeoutMs });
      return;
    }

    if (isApplied(this.getState())) {
      return;
    }

    if (ackMode === 'optimistic') {
      await this.sendCommand(name, args, { waitForReply: false });
      return;
    }

    const timeoutMs = options.timeoutMs ?? this.options.writeTimeoutMs;
    const settleMs = options.settleMs ?? this.options.writeSettleMs;
    const waiter = this.waitForState(isApplied, timeoutMs, settleMs, description);
    try {
      await this.sendCommand(name, args, { waitForReply: false });
      await waiter.promise;
    } catch (error) {
      waiter.cancel();
      throw error;
    }
  }

  async setFrequency(
    frequencyHz: number,
    receiver = this.options.receiver,
    vfo = this.options.vfo,
    options: TciWriteOptions = {},
  ): Promise<void> {
    const frequency = Math.round(frequencyHz);
    const key = rxVfoKey(receiver, vfo);
    await this.sendStateWrite(
      'VFO',
      [receiver, vfo, frequency],
      (state) => state.frequencies[key] === frequency,
      `VFO:${receiver},${vfo},${frequency}`,
      { settleMs: this.options.frequencyWriteSettleMs, ...options },
    );
  }

  async getFrequency(receiver = this.options.receiver, vfo = this.options.vfo): Promise<number | undefined> {
    const reply = await this.request('VFO', [receiver, vfo]);
    return parseNumber(reply.args[2]) ?? this.state.frequencies[rxVfoKey(receiver, vfo)];
  }

  async setMode(mode: string, receiver = this.options.receiver, options: TciWriteOptions = {}): Promise<void> {
    const normalizedMode = mode.toUpperCase();
    const key = rxVfoKey(receiver, this.options.vfo);
    await this.sendStateWrite(
      'MODULATION',
      [receiver, normalizedMode],
      (state) => state.modes[key]?.toLowerCase() === normalizedMode.toLowerCase(),
      `MODULATION:${receiver},${normalizedMode}`,
      options,
    );
  }

  async getMode(receiver = this.options.receiver): Promise<string | undefined> {
    const reply = await this.request('MODULATION', [receiver]);
    const mode = reply.args.length >= 3 ? reply.args[2] : reply.args[1];
    return (mode ?? this.state.modes[rxVfoKey(receiver, this.options.vfo)])?.toLowerCase();
  }

  async setPtt(enabled: boolean, options: TciPttOptions = {}): Promise<void> {
    const trx = options.trx ?? this.options.trx;
    if (options.source && !this.requireDialect().supportsTxAudioSource) {
      throw new TciError('protocol-error', `TCI dialect ${this.requireDialect().id} does not support a TRX audio source argument`);
    }
    const args = options.source ? [trx, enabled, options.source] : [trx, enabled];
    await this.sendStateWrite(
      'TRX',
      args,
      (state) => state.ptt[String(trx)] === enabled,
      `TRX:${trx},${enabled}`,
      options,
    );
  }

  async getPtt(trx = this.options.trx): Promise<boolean | undefined> {
    const reply = await this.request('TRX', [trx]);
    return parseBoolean(reply.args[1]) ?? this.state.ptt[String(trx)];
  }

  async setTune(enabled: boolean, trx = this.options.trx, options: TciWriteOptions = {}): Promise<void> {
    await this.sendStateWrite(
      'TUNE',
      [trx, enabled],
      (state) => state.tune[String(trx)] === enabled,
      `TUNE:${trx},${enabled}`,
      options,
    );
  }

  async setDrive(value: number, trx = this.options.trx): Promise<void> {
    await this.setDriveWithResult(value, trx);
  }

  async setDriveWithResult(value: number, trx = this.options.trx, options: TciWriteOptions = {}): Promise<TciWriteResult<number>> {
    const requested = normalizePercent(value);
    const dialect = this.requireDialect();
    if (this.state.drive[String(trx)] === requested) {
      return writeResult(requested, requested, 'state');
    }

    const timeoutMs = options.timeoutMs ?? this.options.writeTimeoutMs;
    const waiter = this.waitForCommand(
      (command) => command.name === 'drive' && dialect.parseDrive(command.args, trx)?.trx === trx,
      Math.min(500, timeoutMs),
      `DRIVE state for TRX ${trx}`,
    );
    await this.sendCommand('DRIVE', dialect.buildDriveSetArgs(trx, requested), { waitForReply: false });
    try {
      const command = await waiter.promise;
      const applied = dialect.parseDrive(command.args, trx)?.value;
      if (applied !== undefined) return writeResult(requested, applied, 'state');
    } catch (error) {
      if (!(error instanceof TciError) || error.code !== 'command-timeout') throw error;
    } finally {
      waiter.cancel();
    }

    const reply = await this.request('DRIVE', dialect.buildDriveReadArgs(trx), {
      timeoutMs: Math.max(1, timeoutMs - Math.min(500, timeoutMs)),
    });
    const applied = dialect.parseDrive(reply.args, trx)?.value;
    if (applied === undefined) throw new TciError('protocol-error', `Invalid DRIVE readback: ${reply.raw}`);
    return writeResult(requested, applied, 'readback');
  }

  async getDrive(trx = this.options.trx): Promise<number | undefined> {
    const dialect = this.requireDialect();
    const reply = await this.request('DRIVE', dialect.buildDriveReadArgs(trx));
    return dialect.parseDrive(reply.args, trx)?.value ?? this.state.drive[String(trx)];
  }

  async setTuneDrive(value: number, trx = this.options.trx, options: TciWriteOptions = {}): Promise<TciWriteResult<number>> {
    const requested = normalizePercent(value);
    const dialect = this.requireDialect();
    if (this.state.tuneDrive[String(trx)] === requested) return writeResult(requested, requested, 'state');
    const timeoutMs = options.timeoutMs ?? this.options.writeTimeoutMs;
    const waiter = this.waitForCommand(
      (command) => command.name === 'tune_drive' && dialect.parseTuneDrive(command.args, trx)?.trx === trx,
      Math.min(500, timeoutMs),
      `TUNE_DRIVE state for TRX ${trx}`,
    );
    await this.sendCommand('TUNE_DRIVE', dialect.buildTuneDriveSetArgs(trx, requested), { waitForReply: false });
    try {
      const command = await waiter.promise;
      const applied = dialect.parseTuneDrive(command.args, trx)?.value;
      if (applied !== undefined) return writeResult(requested, applied, 'state');
    } catch (error) {
      if (!(error instanceof TciError) || error.code !== 'command-timeout') throw error;
    } finally {
      waiter.cancel();
    }
    const reply = await this.request('TUNE_DRIVE', dialect.buildTuneDriveReadArgs(trx), {
      timeoutMs: Math.max(1, timeoutMs - Math.min(500, timeoutMs)),
    });
    const applied = dialect.parseTuneDrive(reply.args, trx)?.value;
    if (applied === undefined) throw new TciError('protocol-error', `Invalid TUNE_DRIVE readback: ${reply.raw}`);
    return writeResult(requested, applied, 'readback');
  }

  async getTuneDrive(trx = this.options.trx): Promise<number | undefined> {
    const dialect = this.requireDialect();
    const reply = await this.request('TUNE_DRIVE', dialect.buildTuneDriveReadArgs(trx));
    return dialect.parseTuneDrive(reply.args, trx)?.value ?? this.state.tuneDrive[String(trx)];
  }

  async setSplit(enabled: boolean, trx = this.options.trx, options: TciWriteOptions = {}): Promise<void> {
    await this.sendStateWrite(
      'SPLIT_ENABLE',
      [trx, enabled],
      (state) => state.split[String(trx)] === enabled,
      `SPLIT_ENABLE:${trx},${enabled}`,
      options,
    );
  }

  async configureAudio(config: TciAudioConfig): Promise<void> {
    const dialect = this.requireDialect();
    const audio = {
      sampleRate: config.sampleRate,
      sampleType: normalizeSampleType(config.sampleType ?? TciSampleType.FLOAT32),
      channels: config.channels ?? 1,
      samplesPerFrame: config.samplesPerFrame ?? 512,
      txBufferingMs: config.txBufferingMs,
      running: this.state.audio?.running ?? false,
    };
    this.state.audio = audio;

    await this.sendCommand('AUDIO_SAMPLERATE', [audio.sampleRate], { waitForReply: false });
    if (dialect.supportsStreamChannels) {
      await this.sendCommand('AUDIO_STREAM_SAMPLE_TYPE', [sampleTypeName(audio.sampleType)], { waitForReply: false });
      await this.sendCommand('AUDIO_STREAM_CHANNELS', [audio.channels], { waitForReply: false });
      await this.sendCommand('AUDIO_STREAM_SAMPLES', [audio.samplesPerFrame], { waitForReply: false });
      if (audio.txBufferingMs !== undefined) {
        await this.sendCommand('TX_STREAM_AUDIO_BUFFERING', [audio.txBufferingMs], { waitForReply: false });
      }
    }
    this.emitState();
  }

  async startAudio(receiver = this.options.receiver): Promise<void> {
    await this.sendCommand('AUDIO_START', [receiver], { waitForReply: false });
    if (this.state.audio) {
      this.state.audio.running = true;
      this.emitState();
    }
  }

  async stopAudio(receiver = this.options.receiver): Promise<void> {
    await this.sendCommand('AUDIO_STOP', [receiver], { waitForReply: false });
    if (this.state.audio) {
      this.state.audio.running = false;
      this.emitState();
    }
  }

  sendTxAudio(options: BuildTxAudioFrameOptions): void {
    const frame = buildTxAudioFrame({
      receiver: this.options.receiver,
      lengthSemantics: this.requireDialect().streamLengthSemantics,
      ...options,
    });
    this.sendRawBinary(frame);
  }

  sendTxAudioForChrono(request: TciTxChronoRequest, samples: Float32Array | readonly number[]): void {
    const channels = Math.max(1, Math.floor(request.channels || 1));
    const targetSampleLength = Math.max(0, Math.floor(request.sampleCount));
    const output = new Float32Array(targetSampleLength);
    const source = samples instanceof Float32Array ? samples : Float32Array.from(samples);
    output.set(source.subarray(0, output.length));
    this.sendTxAudio({
      receiver: request.receiver,
      sampleRate: request.sampleRate,
      sampleType: request.sampleType,
      channels,
      samples: output,
    });
  }

  async setRxSensorsEnabled(enabled: boolean, intervalMs?: number): Promise<void> {
    const args = intervalMs === undefined ? [enabled] : [enabled, intervalMs];
    await this.sendCommand('RX_SENSORS_ENABLE', args, { waitForReply: false });
  }

  async setTxSensorsEnabled(enabled: boolean, intervalMs?: number): Promise<void> {
    const args = intervalMs === undefined ? [enabled] : [enabled, intervalMs];
    await this.sendCommand('TX_SENSORS_ENABLE', args, { waitForReply: false });
  }

  async sendCwMacro(index: number): Promise<void> {
    await this.sendCommand('CW_MACROS', [index]);
  }

  async sendCwMessage(message: string): Promise<void> {
    await this.sendCommand('CW_MSG', [message]);
  }

  async stopCw(): Promise<void> {
    await this.sendCommand('CW_MACROS_STOP');
  }

  private waitForState(
    predicate: (state: TciClientState) => boolean,
    timeoutMs: number,
    settleMs: number,
    description: string,
  ): { promise: Promise<void>; cancel: () => void } {
    let timeout: NodeJS.Timeout | undefined;
    let settleTimeout: NodeJS.Timeout | undefined;
    let resolved = false;
    let resolvePromise!: () => void;
    let rejectPromise!: (error: TciError) => void;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (settleTimeout) {
        clearTimeout(settleTimeout);
        settleTimeout = undefined;
      }
      this.off('state', onState);
      this.off('disconnected', onDisconnected);
    };

    const resolveNow = () => {
      resolved = true;
      cleanup();
      resolvePromise();
    };

    const check = () => {
      if (!predicate(this.getState())) {
        if (settleTimeout) {
          clearTimeout(settleTimeout);
          settleTimeout = undefined;
        }
        return;
      }

      if (settleMs <= 0) {
        resolveNow();
        return;
      }

      if (settleTimeout) {
        return;
      }

      settleTimeout = setTimeout(() => {
        settleTimeout = undefined;
        if (predicate(this.getState())) {
          resolveNow();
        }
      }, settleMs);
    };

    const onState = () => check();
    const onDisconnected = () => {
      if (resolved) {
        return;
      }
      cleanup();
      rejectPromise(new TciError('disconnected', `Disconnected while waiting for TCI state ${description}`));
    };

    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      timeout = setTimeout(() => {
        cleanup();
        reject(new TciError('command-timeout', `Timed out waiting for TCI state ${description}`));
      }, timeoutMs);
      this.on('state', onState);
      this.on('disconnected', onDisconnected);
      check();
    });

    return {
      promise,
      cancel: cleanup,
    };
  }

  private waitForCommand(
    predicate: (command: TciCommand) => boolean,
    timeoutMs: number,
    description: string,
  ): { promise: Promise<TciCommand>; cancel: () => void } {
    let timer: NodeJS.Timeout | undefined;
    let resolvePromise!: (command: TciCommand) => void;
    let rejectPromise!: (error: TciError) => void;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      this.off('command', onCommand);
      this.off('disconnected', onDisconnected);
    };
    const onCommand = (command: TciCommand) => {
      if (!predicate(command)) return;
      cleanup();
      resolvePromise(command);
    };
    const onDisconnected = () => {
      cleanup();
      rejectPromise(new TciError('disconnected', `Disconnected while waiting for ${description}`));
    };
    const promise = new Promise<TciCommand>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
      timer = setTimeout(() => {
        cleanup();
        reject(new TciError('command-timeout', `Timed out waiting for ${description}`));
      }, timeoutMs);
      this.on('command', onCommand);
      this.on('disconnected', onDisconnected);
    });
    return { promise, cancel: cleanup };
  }

  private resetHandshake(): void {
    this.rejectHandshake(new TciError('cancelled', 'TCI handshake replaced by a new connection'));
    this.handshakeResult = undefined;
    this.handshakeError = undefined;
    this.activeDialect = undefined;
    this.initializationCommands = [];
    this.state.ready = false;
    this.state.protocol = undefined;
    this.state.protocolName = undefined;
    this.state.protocolVersion = undefined;
    this.state.dialectId = undefined;
    this.state.dialectConfidence = undefined;
    this.state.dialectWarnings = [];
  }

  private waitForHandshake(): Promise<TciHandshakeResult> {
    if (this.handshakeResult) return Promise.resolve(cloneHandshake(this.handshakeResult));
    if (this.handshakeError) return Promise.reject(this.handshakeError);
    if (this.handshakeWaiter) {
      return new Promise((resolve, reject) => {
        const onHandshake = (result: TciHandshakeResult) => { cleanup(); resolve(result); };
        const onError = (error: TciError) => { cleanup(); reject(error); };
        const cleanup = () => { this.off('handshake', onHandshake); this.off('error', onError); };
        this.once('handshake', onHandshake);
        this.once('error', onError);
      });
    }
    return new Promise<TciHandshakeResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new TciError('handshake-timeout', `Timed out waiting for TCI READY from ${this.options.url}`);
        this.handshakeWaiter = undefined;
        reject(error);
      }, this.options.handshakeTimeoutMs);
      this.handshakeWaiter = { resolve, reject, timer };
    });
  }

  private finalizeHandshake(): TciHandshakeResult {
    if (this.handshakeResult) return this.handshakeResult;
    assertValidTciHandshake(this.initializationCommands);
    const identity = parseProtocolIdentity(this.initializationCommands);
    const commandNames = [...new Set(this.initializationCommands.map((command) => command.name))];
    const dialect = this.dialectRegistry.select(
      { identity, commands: this.initializationCommands, commandNames: new Set(commandNames) },
      this.options.dialect,
    );
    const result: TciHandshakeResult = { identity, dialect, ready: true, commandNames };
    this.handshakeResult = result;
    this.activeDialect = dialect.dialect;
    this.state.protocolName = identity.programName;
    this.state.protocolVersion = identity.protocolVersion;
    this.state.protocol = identity.protocolVersion ?? identity.programName;
    this.state.device = identity.device ?? this.state.device;
    this.state.dialectId = dialect.dialect.id;
    this.state.dialectConfidence = dialect.confidence;
    this.state.dialectWarnings = [...dialect.warnings];
    const waiter = this.handshakeWaiter;
    this.handshakeWaiter = undefined;
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(cloneHandshake(result));
    }
    this.emit('handshake', cloneHandshake(result));
    return result;
  }

  private rejectHandshake(error: TciError): void {
    const waiter = this.handshakeWaiter;
    this.handshakeWaiter = undefined;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  private requireDialect(): TciDialect {
    if (!this.activeDialect) throw new TciError('invalid-handshake', 'TCI dialect is not available before READY');
    return this.activeDialect;
  }

  private attachTransport(transport: TciTransport): void {
    transport.on('text', (raw) => this.handleText(raw));
    transport.on('binary', (raw) => this.handleBinary(raw));
    transport.on('disconnected', (reason) => this.handleClose(reason));
    transport.on('error', (error) => this.handleError(error));
  }

  private async sendRaw(raw: string): Promise<void> {
    const transport = this.transport;
    if (!transport?.isConnected()) {
      throw new TciError('not-connected', 'TCI socket is not connected');
    }
    this.emit('tci:tx', raw);
    await transport.sendText(raw);
  }

  private sendRawBinary(raw: Buffer): void {
    const transport = this.transport;
    if (!transport?.isConnected()) {
      throw new TciError('not-connected', 'TCI socket is not connected');
    }
    void transport.sendBinary(raw).catch((error) => this.handleError(error));
  }

  private handleText(raw: string): void {
    try {
      const commands = parseTciText(raw);
      this.emit('tci:rx', raw, commands);
      for (const command of commands) {
        if (!this.handshakeResult) this.initializationCommands.push(command);
        this.queue.handleCommand(command);
        this.applyCommand(command);
        this.emit('command', command);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleBinary(data: Buffer): void {
    const frame = parseStreamFrame(data, {
      lengthSemantics: this.requireDialect().streamLengthSemantics,
      negotiatedChannels: this.state.audio?.channels,
    });
    this.emit('tci:binary', frame);
    this.emit('binary', frame);
    switch (frame.streamType) {
      case TciStreamType.RX_AUDIO_STREAM:
        this.emit('rxAudioFrame', frame);
        break;
      case TciStreamType.TX_CHRONO:
        this.emit('txChrono', {
          frame,
          receiver: frame.receiver,
          sampleRate: frame.sampleRate,
          channels: frame.channels,
          sampleType: frame.sampleType,
          sampleCount: frame.sampleCount,
          frameCount: frame.frameCount,
        });
        break;
      case TciStreamType.LINEOUT_STREAM:
        this.emit('lineoutAudioFrame', frame);
        break;
      default:
        break;
    }
  }

  private applyCommand(command: TciCommand): void {
    const readyBefore = this.state.ready;
    this.stateReducers.get(command.name)?.(command.args);

    if (!readyBefore && this.state.ready) {
      try {
        this.finalizeHandshake();
        this.emit('ready', this.getState());
      } catch (error) {
        const tciError = toTciError(error, 'invalid-handshake');
        this.handshakeError = tciError;
        this.state.ready = false;
        this.rejectHandshake(tciError);
        this.handleError(tciError);
      }
    }
    this.emitState();
  }

  private createStateReducers(): Map<string, (args: string[]) => void> {
    const reducers = new Map<string, (args: string[]) => void>();
    reducers.set('ready', (args) => {
      this.state.ready = args.length === 0 ? true : (parseBoolean(args[0]) ?? true);
    });
    reducers.set('protocol', (args) => {
        if (/^\d+(?:\.\d+){0,2}/.test(args[0] ?? '')) {
          this.state.protocol = args[0];
          this.state.protocolVersion = args[0];
        } else {
          this.state.protocolName = args[0];
          this.state.protocolVersion = args[1];
          this.state.protocol = args[1] ?? args[0];
        }
    });
    reducers.set('device', (args) => { this.state.device = args.join(','); });
    reducers.set('receive_only', (args) => { this.state.receiveOnly = parseBoolean(args[0]); });
    reducers.set('trx_count', (args) => { this.state.trxCount = parseNumber(args[0]); });
    const channelCount = (args: string[]) => { this.state.channelCount = parseNumber(args[0]); };
    reducers.set('channels_count', channelCount);
    reducers.set('channel_count', channelCount);
    reducers.set('vfo_limits', (args) => { this.state.vfoLimits = parseNumberPair(args); });
    reducers.set('if_limits', (args) => { this.state.ifLimits = parseNumberPair(args); });
    reducers.set('modulations_list', (args) => { this.state.modulations = args.map((mode) => mode.toLowerCase()); });
    reducers.set('vfo', (args) => this.applyVfo(args));
    reducers.set('modulation', (args) => this.applyModulation(args));
    reducers.set('trx', (args) => this.applyTrx(args));
    reducers.set('tune', (args) => this.applyBooleanByFirstArg(this.state.tune, args));
    reducers.set('drive', (args) => this.applyDrive(args));
    reducers.set('tune_drive', (args) => this.applyTuneDrive(args));
    reducers.set('split_enable', (args) => this.applyBooleanByFirstArg(this.state.split, args));
    reducers.set('rx_channel_sensors', (args) => this.applyRxChannelSensors(args));
    reducers.set('rx_sensors', (args) => this.applyRxSensors(args));
    reducers.set('tx_sensors', (args) => this.applyTxSensors(args));
    reducers.set('audio_samplerate', (args) => this.updateAudioState({ sampleRate: parseNumber(args[0]) }));
    reducers.set('audio_stream_sample_type', (args) => this.updateAudioState({ sampleType: parseSampleType(args[0]) }));
    reducers.set('audio_stream_channels', (args) => this.updateAudioState({ channels: parseNumber(args[0]) }));
    reducers.set('audio_stream_samples', (args) => this.updateAudioState({ samplesPerFrame: parseNumber(args[0]) }));
    reducers.set('tx_stream_audio_buffering', (args) => this.updateAudioState({ txBufferingMs: parseNumber(args[0]) }));
    reducers.set('audio_start', () => this.updateAudioState({ running: true }));
    reducers.set('audio_stop', () => this.updateAudioState({ running: false }));
    return reducers;
  }

  private applyVfo(args: string[]): void {
    if (args.length < 3) {
      return;
    }
    const receiver = parseNumber(args[0]);
    const vfo = parseNumber(args[1]);
    const frequency = parseNumber(args[2]);
    if (receiver === undefined || vfo === undefined || frequency === undefined || frequency < 0) {
      return;
    }
    this.state.frequencies[rxVfoKey(receiver, vfo)] = frequency;
  }

  private applyModulation(args: string[]): void {
    if (args.length < 2) {
      return;
    }
    const receiver = parseNumber(args[0]);
    if (receiver === undefined) {
      return;
    }
    const vfo = args.length >= 3 ? parseNumber(args[1]) ?? this.options.vfo : this.options.vfo;
    const mode = args.length >= 3 ? args[2] : args[1];
    if (!mode) {
      return;
    }
    this.state.modes[rxVfoKey(receiver, vfo)] = mode.toLowerCase();
  }

  private applyTrx(args: string[]): void {
    if (args.length < 2) {
      return;
    }
    const trx = args[0] ?? String(this.options.trx);
    this.state.ptt[trx] = parseBoolean(args[1]) ?? false;
    this.state.pttSource[trx] = args[2]?.toLowerCase();
  }

  private applyBooleanByFirstArg(target: Record<string, boolean>, args: string[]): void {
    if (args.length < 2) {
      return;
    }
    const key = args[0] ?? '0';
    const value = parseBoolean(args[1]);
    if (value !== undefined) {
      target[key] = value;
    }
  }

  private applyDrive(args: string[]): void {
    const parsed = this.activeDialect?.parseDrive(args, this.options.trx)
      ?? parseObservedDrive(args, this.options.trx);
    if (parsed) this.state.drive[String(parsed.trx)] = parsed.value;
  }

  private applyTuneDrive(args: string[]): void {
    const parsed = this.activeDialect?.parseTuneDrive(args, this.options.trx)
      ?? parseObservedDrive(args, this.options.trx);
    if (parsed) this.state.tuneDrive[String(parsed.trx)] = parsed.value;
  }

  private updateAudioState(update: Partial<NonNullable<TciClientState['audio']>>): void {
    this.state.audio = {
      sampleRate: update.sampleRate ?? this.state.audio?.sampleRate ?? 12_000,
      sampleType: update.sampleType ?? this.state.audio?.sampleType ?? TciSampleType.FLOAT32,
      channels: update.channels ?? this.state.audio?.channels ?? 1,
      samplesPerFrame: update.samplesPerFrame ?? this.state.audio?.samplesPerFrame ?? 512,
      txBufferingMs: update.txBufferingMs ?? this.state.audio?.txBufferingMs,
      running: update.running ?? this.state.audio?.running ?? false,
    };
  }

  private applyRxChannelSensors(args: string[]): void {
    if (args.length < 3) {
      return;
    }
    const key = rxVfoKey(args[0], args[1]);
    this.state.rxSensors[key] = {
      receiver: args[0],
      channel: args[1],
      levelDbm: parseNumber(args[2]) ?? args[2],
    };
  }

  private applyRxSensors(args: string[]): void {
    if (args.length < 2) {
      return;
    }
    this.state.rxSensors[String(args[0])] = {
      receiver: args[0],
      levelDbm: parseNumber(args[1]) ?? args[1],
      deprecated: true,
    };
  }

  private applyTxSensors(args: string[]): void {
    if (args.length < 2) {
      return;
    }
    this.state.txSensors[String(args[0])] = {
      trx: args[0],
      micDbm: parseNumber(args[1]) ?? args[1],
      rmsPowerW: parseNumber(args[2]) ?? args[2],
      peakPowerW: parseNumber(args[3]) ?? args[3],
      swr: parseNumber(args[4]) ?? args[4],
    };
  }

  private handleClose(reason?: unknown): void {
    const transport = this.transport;
    this.transport = undefined;
    transport?.removeAllListeners();
    const wasConnected = this.state.connected;
    this.state.connected = false;
    this.state.ready = false;
    this.queue.setConnected(false);
    this.rejectHandshake(new TciError('disconnected', 'TCI connection closed during handshake', reason));
    if (wasConnected) {
      this.emit('disconnected', reason);
      this.emitState();
    }
  }

  private handleError(error: unknown): void {
    const tciError = toTciError(error);
    this.emit('error', tciError);
  }

  private emitState(): void {
    this.emit('state', this.getState());
  }
}

export function createTciClient(options: TciClientOptions): TciClient {
  return new TciClient(options);
}

function rxVfoKey(receiver: string | number, vfo: string | number): string {
  return `${receiver}:${vfo}`;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === '') {
    return undefined;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'off') {
    return false;
  }
  return undefined;
}

function parseSampleType(value: string | undefined): TciSampleType | undefined {
  if (!value) return undefined;
  try { return normalizeSampleType(value.toLowerCase() as TciSampleTypeName); } catch { return undefined; }
}

function parseObservedDrive(args: readonly string[], defaultTrx: number): { trx: number; value: number } | undefined {
  const hasTrx = args.length >= 2;
  const trx = hasTrx ? parseNumber(args[0]) : defaultTrx;
  const value = parseNumber(args[hasTrx ? 1 : 0]);
  return trx === undefined || value === undefined ? undefined : { trx, value };
}

function normalizePercent(value: number): number {
  if (!Number.isFinite(value)) throw new TciError('protocol-error', `Invalid TCI percentage: ${value}`);
  return Math.round(Math.max(0, Math.min(100, value)));
}

function writeResult(
  requested: number,
  applied: number,
  acknowledgement: TciWriteResult<number>['acknowledgement'],
): TciWriteResult<number> {
  return { requested, applied, outcome: requested === applied ? 'applied' : 'clamped', acknowledgement };
}

function parseNumberPair(args: string[]): [number, number] | undefined {
  const first = parseNumber(args[0]);
  const second = parseNumber(args[1]);
  return first === undefined || second === undefined ? undefined : [first, second];
}

function cloneState(state: TciClientState): TciClientState {
  return {
    ...state,
    modulations: [...state.modulations],
    frequencies: { ...state.frequencies },
    modes: { ...state.modes },
    ptt: { ...state.ptt },
    pttSource: { ...state.pttSource },
    tune: { ...state.tune },
    drive: { ...state.drive },
    tuneDrive: { ...state.tuneDrive },
    split: { ...state.split },
    dialectWarnings: [...state.dialectWarnings],
    rxSensors: cloneNested(state.rxSensors),
    txSensors: cloneNested(state.txSensors),
    audio: state.audio ? { ...state.audio } : undefined,
  };
}

function cloneHandshake(result: TciHandshakeResult): TciHandshakeResult {
  return {
    identity: { ...result.identity, rawProtocolArgs: [...result.identity.rawProtocolArgs] },
    dialect: {
      ...result.dialect,
      evidence: [...result.dialect.evidence],
      warnings: [...result.dialect.warnings],
    },
    ready: true,
    commandNames: [...result.commandNames],
  };
}

function cloneNested<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { ...(item as Record<string, unknown>) } as T]));
}
