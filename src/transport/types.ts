import type { EventEmitter } from 'eventemitter3';

export interface TciTransportEvents {
  connected: () => void;
  disconnected: (reason?: unknown) => void;
  text: (raw: string) => void;
  binary: (raw: Buffer) => void;
  error: (error: Error) => void;
}

export interface TciTransport extends EventEmitter<TciTransportEvents> {
  readonly url: string;
  connect(timeoutMs: number): Promise<void>;
  disconnect(code?: number, reason?: string): Promise<void>;
  isConnected(): boolean;
  sendText(raw: string): Promise<void>;
  sendBinary(raw: Buffer): Promise<void>;
  terminate(): void;
}

export type TciTransportFactory = (url: string) => TciTransport;
