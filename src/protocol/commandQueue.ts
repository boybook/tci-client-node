import { TciError } from '../errors.js';
import {
  formatTciCommand,
  isCommandReplyTo,
  parseTciCommand,
  type TciCommand,
  type TciCommandInput,
} from './text.js';

export type TciCommandMatcher = (reply: TciCommand, request: TciCommand) => boolean;

export interface QueueCommandOptions {
  timeoutMs?: number;
  matcher?: TciCommandMatcher;
  signal?: AbortSignal;
}

export interface QueuedCommandResult {
  request: TciCommand;
  reply: TciCommand;
}

interface PendingCommand {
  raw: string;
  request: TciCommand;
  timeoutMs: number;
  matcher: TciCommandMatcher;
  resolve: (result: QueuedCommandResult) => void;
  reject: (error: TciError) => void;
  timer?: NodeJS.Timeout;
  abortCleanup?: () => void;
}

export interface TciCommandQueueOptions {
  send: (raw: string) => void | Promise<void>;
  timeoutMs?: number;
}

export class TciCommandQueue {
  private readonly send: (raw: string) => void | Promise<void>;
  private readonly defaultTimeoutMs: number;
  private queue: PendingCommand[] = [];
  private active?: PendingCommand;
  private connected = true;

  constructor(options: TciCommandQueueOptions) {
    this.send = options.send;
    this.defaultTimeoutMs = options.timeoutMs ?? 1_000;
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    if (!connected) {
      this.cancelAll(new TciError('disconnected', 'TCI connection closed'));
    }
  }

  enqueue(command: TciCommandInput, options: QueueCommandOptions = {}): Promise<QueuedCommandResult> {
    const request = parseTciCommand(command);
    const raw = typeof command === 'string' ? ensureSemicolon(command) : formatTciCommand(command.originalName, command.args);

    if (!this.connected) {
      return Promise.reject(new TciError('not-connected', 'TCI socket is not connected'));
    }

    return new Promise<QueuedCommandResult>((resolve, reject) => {
      const pending: PendingCommand = {
        raw,
        request,
        timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
        matcher: options.matcher ?? ((reply, req) => isCommandReplyTo(reply, req)),
        resolve,
        reject,
      };

      if (options.signal) {
        if (options.signal.aborted) {
          reject(new TciError('cancelled', 'TCI command was cancelled'));
          return;
        }
        const onAbort = () => this.rejectPending(pending, new TciError('cancelled', 'TCI command was cancelled'));
        options.signal.addEventListener('abort', onAbort, { once: true });
        pending.abortCleanup = () => options.signal?.removeEventListener('abort', onAbort);
      }

      this.queue.push(pending);
      void this.pump();
    });
  }

  handleCommand(commandInput: TciCommandInput): boolean {
    const active = this.active;
    if (!active) {
      return false;
    }
    const reply = parseTciCommand(commandInput);
    if (!active.matcher(reply, active.request)) {
      return false;
    }
    this.finishActive(reply);
    return true;
  }

  cancelAll(error = new TciError('cancelled', 'TCI command queue cancelled')): void {
    const pending = [...this.queue];
    this.queue = [];
    if (this.active) {
      pending.unshift(this.active);
      this.active = undefined;
    }
    for (const item of pending) {
      this.rejectPending(item, error);
    }
  }

  get size(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  private async pump(): Promise<void> {
    if (this.active || !this.connected) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.active = next;
    next.timer = setTimeout(() => {
      this.rejectPending(next, new TciError('command-timeout', `Timed out waiting for TCI reply to ${next.raw}`));
      if (this.active === next) {
        this.active = undefined;
      }
      void this.pump();
    }, next.timeoutMs);

    try {
      await this.send(next.raw);
    } catch (error) {
      this.rejectPending(next, new TciError('disconnected', error instanceof Error ? error.message : String(error), error));
      if (this.active === next) {
        this.active = undefined;
      }
      void this.pump();
    }
  }

  private finishActive(reply: TciCommand): void {
    const active = this.active;
    if (!active) {
      return;
    }
    this.active = undefined;
    if (active.timer) {
      clearTimeout(active.timer);
    }
    active.abortCleanup?.();
    active.resolve({ request: active.request, reply });
    void this.pump();
  }

  private rejectPending(pending: PendingCommand, error: TciError): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    pending.abortCleanup?.();
    const wasActive = this.active === pending;
    if (wasActive) {
      this.active = undefined;
    } else {
      this.queue = this.queue.filter((item) => item !== pending);
    }
    pending.reject(error);
    if (wasActive && this.connected) {
      void this.pump();
    }
  }
}

function ensureSemicolon(command: string): string {
  return command.trim().endsWith(';') ? command.trim() : `${command.trim()};`;
}
