import { EventEmitter } from 'eventemitter3';
import WebSocket from 'ws';
import { TciError, toTciError } from '../errors.js';
import type { TciTransport, TciTransportEvents } from './types.js';

export class WebSocketTciTransport extends EventEmitter<TciTransportEvents> implements TciTransport {
  private socket?: WebSocket;

  constructor(readonly url: string, private readonly WebSocketImpl: typeof WebSocket = WebSocket) {
    super();
  }

  async connect(timeoutMs: number): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new this.WebSocketImpl(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        this.terminate();
        reject(new TciError('connect-timeout', `Timed out connecting to ${this.url}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('open', onOpen);
        socket.off('close', onCloseBeforeOpen);
        socket.off('error', onErrorBeforeOpen);
      };
      const onOpen = () => {
        cleanup();
        this.attach(socket);
        this.emit('connected');
        resolve();
      };
      const onCloseBeforeOpen = () => {
        cleanup();
        reject(new TciError('disconnected', `Disconnected while connecting to ${this.url}`));
      };
      const onErrorBeforeOpen = (error: Error) => {
        cleanup();
        reject(toTciError(error, 'disconnected'));
      };
      socket.once('open', onOpen);
      socket.once('close', onCloseBeforeOpen);
      socket.once('error', onErrorBeforeOpen);
    });
  }

  async disconnect(code = 1000, reason = 'client disconnect'): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1_000);
      timer.unref?.();
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      socket.once('error', () => { clearTimeout(timer); resolve(); });
      socket.close(code, reason);
    });
  }

  isConnected(): boolean { return this.socket?.readyState === WebSocket.OPEN; }

  async sendText(raw: string): Promise<void> { await this.send(raw); }
  async sendBinary(raw: Buffer): Promise<void> { await this.send(raw, true); }

  terminate(): void {
    try { this.socket?.terminate(); } catch { /* ignore termination races */ }
  }

  private attach(socket: WebSocket): void {
    socket.on('message', (data, isBinary) => {
      try {
        const buffer = dataToBuffer(data);
        if (isBinary) this.emit('binary', buffer);
        else this.emit('text', buffer.toString('utf8'));
      } catch (error) {
        this.emit('error', error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on('close', (code, reason) => {
      if (this.socket === socket) this.socket = undefined;
      this.emit('disconnected', { code, reason: reason.toString('utf8') });
    });
    socket.on('error', (error) => this.emit('error', error));
  }

  private async send(data: string | Buffer, binary = false): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new TciError('not-connected', 'TCI socket is not connected');
    }
    await new Promise<void>((resolve, reject) => {
      socket.send(data, { binary }, (error) => error ? reject(error) : resolve());
    });
  }
}

function dataToBuffer(data: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data.map((item) => dataToBuffer(item)));
  throw new TciError('protocol-error', 'Unsupported WebSocket data type');
}
