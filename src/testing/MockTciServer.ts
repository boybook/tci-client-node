import { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import {
  buildStreamFrame,
  parseStreamFrame,
  TciSampleType,
  TciStreamType,
  type BuildStreamFrameOptions,
  type TciStreamFrame,
} from '../audio/index.js';
import { formatTciCommand, parseTciText, type TciCommand } from '../protocol/index.js';

export interface MockTciServerOptions {
  port?: number;
  host?: string;
  startupCommands?: string[];
  echoUnknown?: boolean;
  commandDelayMs?: number;
}

export interface MockTciServerCommandContext {
  server: MockTciServer;
  socket: WebSocket;
  command: TciCommand;
}

export type MockTciServerCommandHandler = (context: MockTciServerCommandContext) => void | boolean | Promise<void | boolean>;

export class MockTciServer {
  readonly receivedCommands: TciCommand[] = [];
  readonly receivedTxAudioFrames: TciStreamFrame[] = [];

  private readonly options: Required<Pick<MockTciServerOptions, 'host' | 'echoUnknown' | 'commandDelayMs'>> &
    Pick<MockTciServerOptions, 'port' | 'startupCommands'>;
  private wss?: WebSocketServer;
  private sockets = new Set<WebSocket>();
  private handler?: MockTciServerCommandHandler;
  private frequency = 14_074_000;
  private mode = 'DIGU';
  private ptt = false;

  constructor(options: MockTciServerOptions = {}) {
    this.options = {
      port: options.port ?? 0,
      host: options.host ?? '127.0.0.1',
      startupCommands: options.startupCommands,
      echoUnknown: options.echoUnknown ?? true,
      commandDelayMs: options.commandDelayMs ?? 0,
    };
  }

  async start(): Promise<void> {
    if (this.wss) {
      return;
    }
    this.wss = new WebSocketServer({ port: this.options.port, host: this.options.host });
    this.wss.on('connection', (socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.wss?.once('listening', () => resolve());
      this.wss?.once('error', reject);
    });
  }

  async stop(): Promise<void> {
    const sockets = [...this.sockets];
    await Promise.all(
      sockets.map(
        (socket) =>
          new Promise<void>((resolve) => {
            socket.once('close', () => resolve());
            socket.close();
            setTimeout(() => resolve(), 200).unref?.();
          }),
      ),
    );
    if (!this.wss) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.wss?.close((error) => (error ? reject(error) : resolve()));
    });
    this.wss = undefined;
  }

  url(): string {
    if (!this.wss) {
      throw new Error('MockTciServer is not started');
    }
    const address = this.wss.address() as AddressInfo;
    return `ws://${address.address}:${address.port}`;
  }

  onCommand(handler: MockTciServerCommandHandler): void {
    this.handler = handler;
  }

  broadcast(command: string): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(command.endsWith(';') ? command : `${command};`);
      }
    }
  }

  broadcastCommand(name: string, args: readonly unknown[] = []): void {
    this.broadcast(formatTciCommand(name, args));
  }

  sendRxAudioFrame(options: Partial<BuildStreamFrameOptions> & { samples?: Float32Array | readonly number[] } = {}): void {
    const frame = buildStreamFrame({
      receiver: options.receiver ?? 0,
      sampleRate: options.sampleRate ?? 12_000,
      sampleType: options.sampleType ?? TciSampleType.FLOAT32,
      streamType: TciStreamType.RX_AUDIO_STREAM,
      channels: options.channels ?? 1,
      samples: options.samples ?? new Float32Array(512),
      payload: options.payload,
    });
    this.broadcastBinary(frame);
  }

  sendTxChrono(options: Partial<BuildStreamFrameOptions> & { sampleCount?: number } = {}): void {
    const sampleType = options.sampleType ?? TciSampleType.FLOAT32;
    const channels = options.channels ?? 1;
    const sampleCount = options.sampleCount ?? 512;
    const frame = buildStreamFrame({
      receiver: options.receiver ?? 0,
      sampleRate: options.sampleRate ?? 12_000,
      sampleType,
      streamType: TciStreamType.TX_CHRONO,
      channels,
      payload: options.payload,
      sampleCount,
    });
    this.broadcastBinary(frame);
  }

  closeClients(): void {
    for (const socket of this.sockets) {
      socket.close();
    }
  }

  private handleConnection(socket: WebSocket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('message', (data, isBinary) => void this.handleMessage(socket, data, isBinary));

    const startupCommands = this.options.startupCommands ?? [
      'PROTOCOL:2.0;',
      'DEVICE:Mock ExpertSDR3;',
      'MODULATIONS_LIST:LSB,USB,CW,AM,NFM,DIGU,DIGL;',
      `VFO:0,0,${this.frequency};`,
      `MODULATION:0,${this.mode};`,
      `TRX:0,${this.ptt};`,
      'READY:true;',
    ];
    queueMicrotask(() => {
      for (const command of startupCommands) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(command);
        }
      }
    });
  }

  private async handleMessage(socket: WebSocket, data: WebSocket.RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      const frame = parseStreamFrame(dataToBuffer(data));
      if (frame.streamType === TciStreamType.TX_AUDIO_STREAM) {
        this.receivedTxAudioFrames.push(frame);
      }
      return;
    }

    for (const command of parseTciText(dataToBuffer(data))) {
      this.receivedCommands.push(command);
      if (this.handler) {
        const handled = await this.handler({ server: this, socket, command });
        if (handled === true) {
          continue;
        }
      }
      await this.delay();
      this.defaultReply(socket, command);
    }
  }

  private defaultReply(socket: WebSocket, command: TciCommand): void {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    switch (command.name) {
      case 'vfo': {
        const receiver = command.args[0] ?? '0';
        const vfo = command.args[1] ?? '0';
        if (command.args[2] !== undefined) {
          this.frequency = Number(command.args[2]);
        }
        socket.send(formatTciCommand('VFO', [receiver, vfo, this.frequency]));
        break;
      }
      case 'modulation': {
        const receiver = command.args[0] ?? '0';
        if (command.args[1] !== undefined) {
          this.mode = command.args[command.args.length - 1]?.toUpperCase() ?? this.mode;
        }
        socket.send(formatTciCommand('MODULATION', [receiver, this.mode]));
        break;
      }
      case 'trx': {
        const trx = command.args[0] ?? '0';
        if (command.args[1] !== undefined) {
          this.ptt = command.args[1]?.toLowerCase() === 'true';
        }
        socket.send(formatTciCommand('TRX', [trx, this.ptt]));
        break;
      }
      case 'tune':
      case 'drive':
      case 'split_enable':
      case 'cw_macros':
      case 'cw_msg':
      case 'cw_macros_stop':
      case 'audio_samplerate':
      case 'tx_stream_audio_buffering':
        socket.send(formatTciCommand(command.originalName, command.args));
        break;
      default:
        if (this.options.echoUnknown) {
          socket.send(formatTciCommand(command.originalName, command.args));
        }
        break;
    }
  }

  private broadcastBinary(frame: Buffer): void {
    for (const socket of this.sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame, { binary: true });
      }
    }
  }

  private async delay(): Promise<void> {
    if (this.options.commandDelayMs <= 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, this.options.commandDelayMs));
  }
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
  throw new Error('Unsupported WebSocket data type');
}
