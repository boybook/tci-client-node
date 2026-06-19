import { EventEmitter } from 'eventemitter3';
import type WebSocket from 'ws';

export interface FakeWebSocketSentMessage {
  data: WebSocket.RawData | string;
  isBinary: boolean;
}

export type FakeWebSocketObserver = (socket: FakeWebSocket) => void;

/**
 * Minimal in-memory WebSocket implementation for deterministic TciClient tests.
 * It auto-opens on the next microtask and exposes helpers to inject server data.
 */
export class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly sentMessages: FakeWebSocketSentMessage[] = [];
  readyState = FakeWebSocket.CONNECTING;

  constructor(readonly url: string) {
    super();
    queueMicrotask(() => this.open());
  }

  send(
    data: WebSocket.RawData | string,
    optionsOrCallback?: { binary?: boolean } | ((error?: Error) => void),
    callback?: (error?: Error) => void,
  ): void {
    const done = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    const isBinary = typeof optionsOrCallback === 'object'
      ? Boolean(optionsOrCallback.binary)
      : typeof data !== 'string';

    if (this.readyState !== FakeWebSocket.OPEN) {
      done?.(new Error('FakeWebSocket is not open'));
      return;
    }

    this.sentMessages.push({ data, isBinary });
    this.emit('sent', data, isBinary);
    done?.();
  }

  receive(data: WebSocket.RawData | string, isBinary = typeof data !== 'string'): void {
    if (this.readyState === FakeWebSocket.OPEN) {
      this.emit('message', typeof data === 'string' ? Buffer.from(data) : data, isBinary);
    }
  }

  open(): void {
    if (this.readyState !== FakeWebSocket.CONNECTING) {
      return;
    }
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  close(code = 1000, reason = 'fake close'): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit('close', code, Buffer.from(reason));
    });
  }

  terminate(): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1006, Buffer.from('terminated'));
  }
}

export function createFakeWebSocketImpl(observer?: FakeWebSocketObserver): typeof WebSocket {
  return class FakeWebSocketImpl extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      observer?.(this);
    }
  } as unknown as typeof WebSocket;
}
