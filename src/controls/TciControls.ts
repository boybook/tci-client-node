import { EventEmitter } from 'eventemitter3';
import { TciError } from '../errors.js';
import { formatTciCommand, type TciCommand } from '../protocol/text.js';
import type { QueueCommandOptions, QueuedCommandResult } from '../protocol/commandQueue.js';
import type {
  TciControlAdapter, TciControlContext, TciControlDescriptor, TciControlId, TciControlRange,
  TciControlRequestOptions, TciControlState, TciControlTarget, TciControlValue,
  TciControlValueMap, TciControlWriteResult, TciDecodedControl,
} from './types.js';

interface Events {
  changed: (state: TciControlState) => void;
  capabilitiesChanged: (descriptors: TciControlDescriptor[]) => void;
}
interface Port {
  enqueue(raw: string, options: QueueCommandOptions): Promise<QueuedCommandResult>;
  timeoutMs: number;
}

/** One session's parameter state. It never owns a socket, polling timer or radio policy. */
export class TciControls extends EventEmitter<Events> {
  private adapter?: TciControlAdapter;
  private context?: TciControlContext;
  private descriptors = new Map<TciControlId, TciControlDescriptor>();
  private states = new Map<string, TciControlState>();
  private algorithms = new Map<string, TciControlState>();
  private reads = new Map<string, Promise<TciControlState>>();
  private revision = 0;
  private epoch = 0;

  constructor(private readonly port: Port) { super(); }

  configure(adapter: TciControlAdapter | undefined, context: TciControlContext, commands: readonly TciCommand[]): void {
    this.reset();
    this.context = { ...context };
    this.adapter = adapter;
    this.descriptors = new Map(adapter?.descriptors(context).map((d) => [d.id, structuredClone(d)]) ?? []);
    for (const command of commands) this.accept(command, 'initialization');
    this.emit('capabilitiesChanged', this.getCapabilities());
  }

  reset(): void {
    this.epoch += 1;
    this.adapter = undefined;
    this.context = undefined;
    this.descriptors.clear(); this.states.clear(); this.reads.clear(); this.algorithms.clear();
    this.revision = 0;
  }

  supports(id: TciControlId): boolean { return this.descriptors.get(id)?.support === 'implemented'; }

  getCapabilities(target?: TciControlTarget): TciControlDescriptor[] {
    return [...this.descriptors.values()].map((d) => {
      const result = structuredClone(d);
      const selected = target ?? (this.context ? this.defaultTarget(d) : undefined);
      if (selected && !this.targetExists(selected)) {
        result.readable = false; result.writable = false;
        result.reason = 'Target is outside the current receiver/channel topology';
      }
      if ((d.id === 'rx_channel_enable' && selected?.scope === 'channel' && selected.channel === 0)
        || (d.id === 'rx_enable' && selected?.scope === 'receiver' && selected.receiver === 0)) {
        result.writable = false;
        result.reason = 'The primary receiver/channel is always enabled';
      }
      return result;
    });
  }

  getState<K extends TciControlId>(id: K, target?: TciControlTarget): TciControlState<K> | undefined {
    const d = this.descriptors.get(id);
    if (!d || !this.context) return undefined;
    const addressed = target ?? this.defaultTarget(d);
    const state = this.states.get(controlKey(id, addressed));
    return state ? structuredClone(state) as TciControlState<K> : undefined;
  }

  accept(command: TciCommand, source: TciControlState['source'] = 'broadcast'): void {
    if (!this.adapter || !this.context) return;
    if (['trx_count', 'channel_count', 'channels_count'].includes(command.name) && command.args.length === 1) {
      const count = Number(command.args[0]);
      const key = command.name === 'trx_count' ? 'receiverCount' : 'channelCount';
      if (command.args[0].trim() && Number.isInteger(count) && count >= 0 && count <= 64 && count !== this.context[key]) {
        this.context[key] = count;
        for (const state of this.states.values()) {
          if (this.targetExists(state.target) || state.availability === 'unavailable') continue;
          state.availability = 'unavailable'; state.lastError = 'Control target is no longer available';
          state.revision = ++this.revision; state.updatedAt = Date.now();
          this.emit('changed', structuredClone(state));
        }
        this.emit('capabilitiesChanged', this.getCapabilities());
      }
    }
    if (command.name === 'modulations_list') this.setOptions('modulation', command.args.map((v) => v.toLowerCase()));
    for (const decoded of this.adapter.decode(command, this.context)) {
      const d = this.descriptors.get(decoded.id);
      if (d?.support !== 'implemented') continue;
      try { validateValue(d, decoded.value, false); } catch { continue; }
      const key = controlKey(decoded.id, decoded.target);
      const previous = this.states.get(key);
      const state: TciControlState = { ...decoded, value: structuredClone(decoded.value),
        availability: 'available', source, revision: ++this.revision, updatedAt: Date.now() };
      this.states.set(key, state);
      if ((decoded.id === 'rx_nr_algorithm' || decoded.id === 'rx_nb_algorithm') && Number(decoded.value) > 0) this.algorithms.set(key, state);
      if (decoded.id === 'tx_profiles_ex') this.setOptions('tx_profile_ex', decoded.value as string[]);
      if (!previous || previous.availability !== 'available' || !valuesEqual(previous.value, state.value)) {
        this.emit('changed', structuredClone(state));
      }
    }
  }

  read<K extends TciControlId>(id: K, target?: TciControlTarget, options: TciControlRequestOptions = {}): Promise<TciControlState<K>> {
    const { descriptor, addressed } = this.resolve(id, target);
    if (!descriptor.readable) return Promise.reject(controlError('unsupported-control', `Control ${id} cannot be queried`));
    const key = controlKey(id, addressed);
    // Independently cancellable callers retain their own transaction.
    const existing = options.signal ? undefined : this.reads.get(key);
    if (existing) return existing as Promise<TciControlState<K>>;
    const command = this.adapter!.read(id, addressed);
    if (!command) return Promise.reject(controlError('unsupported-control', `No query for ${id}`));
    const epoch = this.epoch;
    const promise = this.port.enqueue(formatTciCommand(command.name, command.args), {
      timeoutMs: options.timeoutMs ?? this.port.timeoutMs, signal: options.signal,
      matcher: (reply) => Boolean(this.decodeMatch(reply, id, addressed)),
    }).then((result) => {
      this.assertEpoch(epoch);
      this.accept(result.reply, 'readback');
      const state = this.getState(id, addressed);
      if (!state) throw controlError('protocol-error', `Missing decoded state for ${id}`);
      return state;
    }).catch((error) => {
      if (epoch === this.epoch) this.markUnavailable(id, addressed, error);
      throw error;
    }).finally(() => { if (this.reads.get(key) === promise) this.reads.delete(key); });
    if (!options.signal) this.reads.set(key, promise);
    return promise;
  }

  async write<K extends TciControlId>(id: K, value: TciControlValueMap[K], target?: TciControlTarget,
    options: TciControlRequestOptions = {}): Promise<TciControlWriteResult<K>> {
    const { descriptor, addressed } = this.resolve(id, target);
    if (!descriptor.writable) throw controlError('unsupported-control', `Control ${id} is read-only`);
    validateValue(descriptor, value, true);
    const current = this.getState(id, addressed);
    if (descriptor.valueType !== 'action' && current?.availability === 'available' && valuesEqual(current.value, value)) {
      return { requested: value, applied: current.value, outcome: 'applied', acknowledgement: 'state' };
    }
    const epoch = this.epoch;
    const command = this.adapter!.write(id, addressed, value, (key, t) => {
      const state = this.getState(key, t);
      return (key === 'rx_nr_algorithm' || key === 'rx_nb_algorithm') && state?.value === 0
        ? this.algorithms.get(controlKey(key, t)) ?? state : state;
    });
    const query = descriptor.readable ? this.adapter!.read(id, addressed) : undefined;
    const timeoutMs = options.timeoutMs ?? this.port.timeoutMs;
    try {
      const result = await this.port.enqueue(formatTciCommand(command.name, command.args), {
        timeoutMs, signal: options.signal, sendOnly: descriptor.confirmation === 'sent',
        matcher: (reply, _request, readback) => {
          const decoded = this.decodeMatch(reply, id, addressed);
          return Boolean(decoded && (readback || descriptor.confirmation !== 'exact' || valuesEqual(decoded.value, value)));
        },
        readback: query ? {
          command: formatTciCommand(query.name, query.args),
          afterMs: Math.min(descriptor.confirmation === 'readback' ? 100 : 250, timeoutMs / 2),
          required: descriptor.confirmation === 'readback',
        } : undefined,
      });
      this.assertEpoch(epoch);
      if (descriptor.confirmation === 'sent') return { requested: value, applied: null, outcome: 'sent', acknowledgement: 'sent' };
      const decoded = this.decodeMatch(result.reply, id, addressed)!;
      const equal = valuesEqual(decoded.value, value);
      if (!equal && (descriptor.confirmation === 'exact' || descriptor.valueType === 'boolean' || descriptor.valueType === 'enum')) throw controlError('control-rejected', `Control ${id} did not apply the requested value`);
      this.accept(result.reply, result.readback ? 'readback' : 'broadcast');
      return { requested: structuredClone(value), applied: structuredClone(decoded.value) as TciControlValueMap[K],
        outcome: equal ? 'applied' : 'clamped', acknowledgement: result.readback ? 'readback' : 'state' };
    } catch (error) {
      if (epoch === this.epoch) this.markUnavailable(id, addressed, error);
      throw error;
    }
  }

  private resolve(id: TciControlId, target?: TciControlTarget) {
    if (!this.context || !this.adapter) throw controlError('unsupported-control', 'The dialect does not declare parameter controls');
    const d = this.descriptors.get(id);
    if (!d || d.support !== 'implemented') throw controlError('unsupported-control', `Control ${id} is not implemented by this dialect`);
    const addressed = target ?? this.defaultTarget(d);
    if (addressed.scope !== d.scope) throw controlError('invalid-control-value', `Invalid target scope for ${id}`);
    if ('receiver' in addressed) validateIndex(addressed.receiver, this.context.receiverCount);
    if ('trx' in addressed) validateIndex(addressed.trx, this.context.receiverCount);
    if ('channel' in addressed) validateIndex(addressed.channel, this.context.channelCount);
    const descriptor = this.getCapabilities(addressed).find((candidate) => candidate.id === id)!;
    return { descriptor, addressed };
  }

  private defaultTarget(d: TciControlDescriptor): TciControlTarget {
    const ctx = this.context!;
    switch (d.scope) {
      case 'global': return { scope: 'global' };
      case 'receiver': return { scope: 'receiver', receiver: ctx.receiver };
      case 'trx': return { scope: 'trx', trx: ctx.trx };
      case 'channel': return { scope: 'channel', receiver: ctx.receiver, channel: ctx.channel };
    }
  }

  private targetExists(target: TciControlTarget): boolean {
    const count = this.context?.receiverCount ?? 64;
    return (!('receiver' in target) || target.receiver < count)
      && (!('trx' in target) || target.trx < count)
      && (!('channel' in target) || target.channel < (this.context?.channelCount ?? 64));
  }

  private decodeMatch(command: TciCommand, id: TciControlId, target: TciControlTarget): TciDecodedControl | undefined {
    if (!this.context || !this.adapter) return undefined;
    const match = this.adapter.decode(command, this.context).find((value) => controlKey(value.id, value.target) === controlKey(id, target));
    if (match) {
      try { validateValue(this.descriptors.get(id)!, match.value, false); } catch { return undefined; }
    }
    return match;
  }

  private setOptions(id: TciControlId, options: readonly (string | number)[]): void {
    const d = this.descriptors.get(id);
    if (!d || valuesEqual(d.options, options)) return;
    d.options = [...options];
    this.emit('capabilitiesChanged', this.getCapabilities());
  }

  private markUnavailable(id: TciControlId, target: TciControlTarget, error: unknown): void {
    if (error instanceof TciError && ['cancelled', 'disconnected', 'not-connected'].includes(error.code)) return;
    const key = controlKey(id, target);
    const state: TciControlState = { id, target: { ...target }, value: this.states.get(key)?.value ?? null,
      availability: 'unavailable', source: 'readback', revision: ++this.revision, updatedAt: Date.now(), lastError: String(error) };
    this.states.set(key, state); this.emit('changed', structuredClone(state));
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw controlError('cancelled', 'Control operation belongs to an expired session');
  }
}

export function controlKey(id: TciControlId, target: TciControlTarget): string {
  return `${id}:${target.scope}:${'receiver' in target ? target.receiver : 'trx' in target ? target.trx : ''}:${'channel' in target ? target.channel : ''}`;
}

function validateIndex(value: number, count = 64): void {
  if (!Number.isInteger(value) || value < 0 || value >= count) throw controlError('invalid-control-value', `Invalid receiver/channel index ${value}`);
}
function validateNumber(value: unknown, range: TciControlRange | undefined, checkRange: boolean): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw controlError('invalid-control-value', 'Expected a finite number');
  if (!checkRange) return;
  if ((range?.min !== undefined && value < range.min) || (range?.max !== undefined && value > range.max)) throw controlError('invalid-control-value', 'Control value is outside the declared range');
  if (range?.step && Math.abs((value - (range.min ?? 0)) / range.step - Math.round((value - (range.min ?? 0)) / range.step)) > 1e-7) throw controlError('invalid-control-value', 'Control value is not on a supported step');
}
function validateValue(d: TciControlDescriptor, value: TciControlValue, write: boolean): void {
  switch (d.valueType) {
    case 'boolean': if (typeof value !== 'boolean') throw controlError('invalid-control-value', 'Expected a boolean'); break;
    case 'number': validateNumber(value, d.range, write); break;
    case 'enum':
      if (typeof value !== 'string' && typeof value !== 'number') throw controlError('invalid-control-value', 'Expected an enum value');
      if (typeof value === 'number') validateNumber(value, undefined, false);
      if (write && d.options && !d.options.includes(value)) throw controlError('invalid-control-value', 'Value is not a declared option');
      if (typeof value === 'string' && (!value || /[:;,^~*]/.test(value))) throw controlError('invalid-control-value', 'Invalid enum text');
      break;
    case 'fields': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw controlError('invalid-control-value', 'Expected complete control fields');
      const fields = value as unknown as Record<string, number>;
      const keys = Object.keys(d.fields!);
      if (Object.keys(fields).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))) throw controlError('invalid-control-value', 'Expected exact control field set');
      for (const key of keys) validateNumber(fields[key], d.fields![key], write);
      if ('lowHz' in fields && fields.lowHz >= fields.highHz) throw controlError('invalid-control-value', 'Filter low edge must be below high edge');
      if (write && d.id === 'tx_filter_band_ex' && fields.highHz - fields.lowHz < 100) throw controlError('invalid-control-value', 'TX passband must be at least 100 Hz');
      break;
    }
    case 'list': if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw controlError('invalid-control-value', 'Expected a string list'); break;
    case 'action': if (value !== null) throw controlError('invalid-control-value', 'An action has no value'); break;
  }
}
function valuesEqual(a: unknown, b: unknown): boolean {
  return Object.is(a, b) || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
}
function controlError(code: TciError['code'], message: string): TciError { return new TciError(code, message); }
