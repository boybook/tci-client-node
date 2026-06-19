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

export interface TciClientOptions {
  url: string;
  receiver?: number;
  trx?: number;
  vfo?: number;
  connectTimeoutMs?: number;
  commandTimeoutMs?: number;
  WebSocketImpl?: typeof WebSocket;
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
}

export interface TciTxChronoRequest {
  frame: TciStreamFrame;
  receiver: number;
  sampleRate: number;
  channels: number;
  sampleType: TciSampleType;
  sampleCount: number;
}

export interface TciClientState {
  connected: boolean;
  ready: boolean;
  protocol?: string;
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
  state: (state: TciClientState) => void;
  command: (command: TciCommand) => void;
  binary: (frame: TciStreamFrame) => void;
  rxAudioFrame: (frame: TciStreamFrame) => void;
  lineoutAudioFrame: (frame: TciStreamFrame) => void;
  txChrono: (request: TciTxChronoRequest) => void;
  error: (error: TciError) => void;
}

export interface SendCommandOptions extends QueueCommandOptions {
  waitForReply?: boolean;
}

export class TciClient extends EventEmitter<TciClientEvents> {
  readonly options: Required<Pick<TciClientOptions, 'receiver' | 'trx' | 'vfo' | 'connectTimeoutMs' | 'commandTimeoutMs'>> &
    Pick<TciClientOptions, 'url'>;

  private readonly WebSocketImpl: typeof WebSocket;
  private ws?: WebSocket;
  private readonly queue: TciCommandQueue;
  private readonly state: TciClientState;

  constructor(options: TciClientOptions) {
    super();
    this.options = {
      url: options.url,
      receiver: options.receiver ?? 0,
      trx: options.trx ?? 0,
      vfo: options.vfo ?? 0,
      connectTimeoutMs: options.connectTimeoutMs ?? 5_000,
      commandTimeoutMs: options.commandTimeoutMs ?? 1_000,
    };
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
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
      split: {},
      rxSensors: {},
      txSensors: {},
    };
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      await this.waitForOpen(this.ws);
      return;
    }

    const ws = new this.WebSocketImpl(this.options.url);
    this.ws = ws;
    await this.waitForOpen(ws);
  }

  async disconnect(code = 1000, reason = 'client disconnect'): Promise<void> {
    const ws = this.ws;
    if (!ws) {
      return;
    }
    if (ws.readyState === WebSocket.CLOSED) {
      this.handleClose();
      return;
    }
    await new Promise<void>((resolve) => {
      const cleanup = () => {
        ws.off('close', onClose);
        ws.off('error', onError);
      };
      const onClose = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        resolve();
      };
      ws.once('close', onClose);
      ws.once('error', onError);
      ws.close(code, reason);
      setTimeout(() => resolve(), 1_000).unref?.();
    });
    this.handleClose();
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  getState(): TciClientState {
    return cloneState(this.state);
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

  async setFrequency(frequencyHz: number, receiver = this.options.receiver, vfo = this.options.vfo): Promise<void> {
    await this.sendCommand('VFO', [receiver, vfo, Math.round(frequencyHz)]);
  }

  async getFrequency(receiver = this.options.receiver, vfo = this.options.vfo): Promise<number | undefined> {
    const reply = await this.request('VFO', [receiver, vfo]);
    return parseNumber(reply.args[2]) ?? this.state.frequencies[rxVfoKey(receiver, vfo)];
  }

  async setMode(mode: string, receiver = this.options.receiver): Promise<void> {
    await this.sendCommand('MODULATION', [receiver, mode.toUpperCase()]);
  }

  async getMode(receiver = this.options.receiver): Promise<string | undefined> {
    const reply = await this.request('MODULATION', [receiver]);
    const mode = reply.args.length >= 3 ? reply.args[2] : reply.args[1];
    return (mode ?? this.state.modes[rxVfoKey(receiver, this.options.vfo)])?.toLowerCase();
  }

  async setPtt(enabled: boolean, options: TciPttOptions = {}): Promise<void> {
    const trx = options.trx ?? this.options.trx;
    const args = options.source ? [trx, enabled, options.source] : [trx, enabled];
    await this.sendCommand('TRX', args);
  }

  async getPtt(trx = this.options.trx): Promise<boolean | undefined> {
    const reply = await this.request('TRX', [trx]);
    return parseBoolean(reply.args[1]) ?? this.state.ptt[String(trx)];
  }

  async setTune(enabled: boolean, trx = this.options.trx): Promise<void> {
    await this.sendCommand('TUNE', [trx, enabled]);
  }

  async setDrive(value: number, trx = this.options.trx): Promise<void> {
    await this.sendCommand('DRIVE', [trx, value]);
  }

  async setSplit(enabled: boolean, trx = this.options.trx): Promise<void> {
    await this.sendCommand('SPLIT_ENABLE', [trx, enabled]);
  }

  async configureAudio(config: TciAudioConfig): Promise<void> {
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
    await this.sendCommand('AUDIO_STREAM_SAMPLE_TYPE', [sampleTypeName(audio.sampleType)], { waitForReply: false });
    await this.sendCommand('AUDIO_STREAM_CHANNELS', [audio.channels], { waitForReply: false });
    await this.sendCommand('AUDIO_STREAM_SAMPLES', [audio.samplesPerFrame], { waitForReply: false });
    if (audio.txBufferingMs !== undefined) {
      await this.sendCommand('TX_STREAM_AUDIO_BUFFERING', [audio.txBufferingMs], { waitForReply: false });
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
    const frame = buildTxAudioFrame({ receiver: this.options.receiver, ...options });
    this.sendRawBinary(frame);
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

  private waitForOpen(ws: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.terminate();
        } catch {
          // ignore termination races
        }
        reject(new TciError('connect-timeout', `Timed out connecting to ${this.options.url}`));
      }, this.options.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timer);
        ws.off('open', onOpen);
        ws.off('close', onClose);
        ws.off('error', onError);
      };
      const onOpen = () => {
        cleanup();
        this.attachSocket(ws);
        this.state.connected = true;
        this.queue.setConnected(true);
        this.emit('connected');
        this.emitState();
        resolve();
      };
      const onClose = () => {
        cleanup();
        this.handleClose();
        reject(new TciError('disconnected', `Disconnected while connecting to ${this.options.url}`));
      };
      const onError = (error: Error) => {
        cleanup();
        this.handleError(error);
        reject(toTciError(error, 'disconnected'));
      };
      ws.once('open', onOpen);
      ws.once('close', onClose);
      ws.once('error', onError);
    });
  }

  private attachSocket(ws: WebSocket): void {
    ws.on('message', (data, isBinary) => this.handleMessage(data, isBinary));
    ws.on('close', () => this.handleClose());
    ws.on('error', (error) => this.handleError(error));
  }

  private async sendRaw(raw: string): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new TciError('not-connected', 'TCI socket is not connected');
    }
    await new Promise<void>((resolve, reject) => {
      ws.send(raw, (error) => (error ? reject(error) : resolve()));
    });
  }

  private sendRawBinary(raw: Buffer): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new TciError('not-connected', 'TCI socket is not connected');
    }
    ws.send(raw, { binary: true });
  }

  private handleMessage(data: WebSocket.RawData, isBinary: boolean): void {
    try {
      if (isBinary) {
        this.handleBinary(data);
        return;
      }
      const commands = parseTciText(dataToBuffer(data));
      for (const command of commands) {
        this.queue.handleCommand(command);
        this.applyCommand(command);
        this.emit('command', command);
      }
    } catch (error) {
      this.handleError(error);
    }
  }

  private handleBinary(data: WebSocket.RawData): void {
    const frame = parseStreamFrame(dataToBuffer(data));
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
    switch (command.name) {
      case 'ready':
        this.state.ready = command.args.length === 0 ? true : (parseBoolean(command.args[0]) ?? true);
        break;
      case 'protocol':
        this.state.protocol = command.args[0];
        break;
      case 'device':
        this.state.device = command.args.join(',');
        break;
      case 'receive_only':
        this.state.receiveOnly = parseBoolean(command.args[0]);
        break;
      case 'trx_count':
        this.state.trxCount = parseNumber(command.args[0]);
        break;
      case 'channels_count':
      case 'channel_count':
        this.state.channelCount = parseNumber(command.args[0]);
        break;
      case 'vfo_limits':
        this.state.vfoLimits = parseNumberPair(command.args);
        break;
      case 'if_limits':
        this.state.ifLimits = parseNumberPair(command.args);
        break;
      case 'modulations_list':
        this.state.modulations = command.args.map((mode) => mode.toLowerCase());
        break;
      case 'vfo':
        this.applyVfo(command.args);
        break;
      case 'modulation':
        this.applyModulation(command.args);
        break;
      case 'trx':
        this.applyTrx(command.args);
        break;
      case 'tune':
        this.applyBooleanByFirstArg(this.state.tune, command.args);
        break;
      case 'drive':
        this.applyDrive(command.args);
        break;
      case 'split_enable':
        this.applyBooleanByFirstArg(this.state.split, command.args);
        break;
      case 'rx_channel_sensors':
        this.applyRxChannelSensors(command.args);
        break;
      case 'rx_sensors':
        this.applyRxSensors(command.args);
        break;
      case 'tx_sensors':
        this.applyTxSensors(command.args);
        break;
      case 'audio_samplerate':
        this.state.audio = {
          sampleRate: parseNumber(command.args[0]) ?? this.state.audio?.sampleRate ?? 12_000,
          sampleType: this.state.audio?.sampleType ?? TciSampleType.FLOAT32,
          channels: this.state.audio?.channels ?? 1,
          samplesPerFrame: this.state.audio?.samplesPerFrame ?? 512,
          txBufferingMs: this.state.audio?.txBufferingMs,
          running: this.state.audio?.running ?? false,
        };
        break;
      default:
        break;
    }

    if (!readyBefore && this.state.ready) {
      this.emit('ready', this.getState());
    }
    this.emitState();
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
    if (args.length === 1) {
      const value = parseNumber(args[0]);
      if (value !== undefined) {
        this.state.drive[String(this.options.trx)] = value;
      }
      return;
    }
    const trx = args[0] ?? String(this.options.trx);
    const value = parseNumber(args[1]);
    if (value !== undefined) {
      this.state.drive[trx] = value;
    }
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
    this.ws = undefined;
    const wasConnected = this.state.connected;
    this.state.connected = false;
    this.state.ready = false;
    this.queue.setConnected(false);
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

function dataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((item) => dataToBuffer(item)));
  }
  throw new TciError('protocol-error', 'Unsupported WebSocket data type');
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
    split: { ...state.split },
    rxSensors: cloneNested(state.rxSensors),
    txSensors: cloneNested(state.txSensors),
    audio: state.audio ? { ...state.audio } : undefined,
  };
}

function cloneNested<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, { ...(item as Record<string, unknown>) } as T]));
}
