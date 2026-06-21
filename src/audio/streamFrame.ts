import { TciError } from '../errors.js';

export const TCI_STREAM_HEADER_BYTES = 16 * 4;

export enum TciStreamType {
  IQ_STREAM = 0,
  RX_AUDIO_STREAM = 1,
  TX_AUDIO_STREAM = 2,
  TX_CHRONO = 3,
  LINEOUT_STREAM = 4,
}

export enum TciSampleType {
  INT16 = 0,
  INT24 = 1,
  INT32 = 2,
  FLOAT32 = 3,
}

export type TciSampleTypeName = 'int16' | 'int24' | 'int32' | 'float32';

export interface TciStreamFrame {
  receiver: number;
  sampleRate: number;
  sampleType: TciSampleType;
  codec: number;
  crc: number;
  /** Byte length of the payload following the 64-byte TCI stream header. */
  payloadLength: number;
  streamType: TciStreamType;
  channels: number;
  reserved: number[];
  payload: Buffer;
  /** Official Stream.length value: number of samples per channel in the payload. */
  sampleCount: number;
}

export interface BuildStreamFrameOptions {
  receiver?: number;
  sampleRate: number;
  sampleType: TciSampleType | TciSampleTypeName;
  streamType: TciStreamType;
  channels: number;
  payload?: Buffer | Uint8Array | ArrayBuffer | ArrayBufferView;
  samples?: Float32Array | readonly number[];
  /** Explicit Stream.length value, used for header-only frames such as TX_CHRONO. */
  sampleCount?: number;
  codec?: number;
  crc?: number;
  reserved?: readonly number[];
}

export interface BuildTxAudioFrameOptions extends Omit<BuildStreamFrameOptions, 'streamType'> {
  receiver?: number;
}

export function parseStreamFrame(input: Buffer | ArrayBuffer | ArrayBufferView): TciStreamFrame {
  const buffer = toBuffer(input);
  if (buffer.byteLength < TCI_STREAM_HEADER_BYTES) {
    throw new TciError('invalid-frame', `TCI stream frame is shorter than ${TCI_STREAM_HEADER_BYTES} bytes`);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const header = Array.from({ length: 16 }, (_, index) => view.getUint32(index * 4, true));
  const sampleType = normalizeSampleType(header[2]);
  const streamType = normalizeStreamType(header[6]);
  let channels = header[7];
  const bytesPerSample = sampleTypeBytes(sampleType);
  const sampleCount = header[5];
  const actualPayloadLength = buffer.byteLength - TCI_STREAM_HEADER_BYTES;
  if (channels <= 0) {
    if (streamType === TciStreamType.TX_CHRONO && actualPayloadLength === 0) {
      channels = 1;
    } else {
      const inferredChannels = sampleCount > 0 ? actualPayloadLength / sampleCount / bytesPerSample : 1;
      if (!Number.isInteger(inferredChannels) || inferredChannels <= 0) {
        throw new TciError('invalid-frame', `Invalid TCI channel count: ${channels}`);
      }
      channels = inferredChannels;
    }
  }
  const payloadLength = actualPayloadLength;
  const alignedFrameBytes = bytesPerSample * channels;
  if (payloadLength % alignedFrameBytes !== 0) {
    throw new TciError('invalid-frame', 'TCI payload length is not aligned to sample type and channel count');
  }

  if (streamType !== TciStreamType.TX_CHRONO) {
    const expectedPerChannelPayloadLength = sampleCount * bytesPerSample * channels;
    const expectedScalarPayloadLength = sampleCount * bytesPerSample;
    if (payloadLength !== expectedPerChannelPayloadLength && payloadLength !== expectedScalarPayloadLength) {
      throw new TciError(
        'invalid-frame',
        `TCI stream frame length mismatch: header says ${sampleCount} samples (${expectedPerChannelPayloadLength} payload bytes), got ${payloadLength}`,
      );
    }
  }

  return {
    receiver: header[0],
    sampleRate: header[1],
    sampleType,
    codec: header[3],
    crc: header[4],
    payloadLength,
    streamType,
    channels,
    reserved: header.slice(8),
    payload: buffer.subarray(TCI_STREAM_HEADER_BYTES),
    sampleCount,
  };
}

export function buildStreamFrame(options: BuildStreamFrameOptions): Buffer {
  const sampleType = normalizeSampleType(options.sampleType);
  const payload = options.payload ? toBuffer(options.payload) : samplesToPayload(options.samples ?? [], sampleType);
  const channels = options.channels;
  if (channels <= 0) {
    throw new TciError('invalid-frame', `Invalid TCI channel count: ${channels}`);
  }
  const bytesPerSample = sampleTypeBytes(sampleType);
  if (payload.byteLength % (bytesPerSample * channels) !== 0) {
    throw new TciError('invalid-frame', 'TCI payload length is not aligned to sample type and channel count');
  }
  const derivedSampleCount = payload.byteLength / bytesPerSample / channels;
  const sampleCount = options.sampleCount ?? derivedSampleCount;
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new TciError('invalid-frame', `Invalid TCI sample count: ${sampleCount}`);
  }

  const frame = Buffer.alloc(TCI_STREAM_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const reserved = options.reserved ?? [];
  const header = [
    options.receiver ?? 0,
    options.sampleRate,
    sampleType,
    options.codec ?? 0,
    options.crc ?? 0,
    sampleCount,
    options.streamType,
    channels,
    ...Array.from({ length: 8 }, (_, index) => reserved[index] ?? 0),
  ];
  header.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  payload.copy(frame, TCI_STREAM_HEADER_BYTES);
  return frame;
}

export function buildTxAudioFrame(options: BuildTxAudioFrameOptions): Buffer {
  return buildStreamFrame({ ...options, streamType: TciStreamType.TX_AUDIO_STREAM });
}

export function sampleTypeBytes(sampleType: TciSampleType | TciSampleTypeName): number {
  switch (normalizeSampleType(sampleType)) {
    case TciSampleType.INT16:
      return 2;
    case TciSampleType.INT24:
      return 3;
    case TciSampleType.INT32:
    case TciSampleType.FLOAT32:
      return 4;
    default:
      throw new TciError('invalid-frame', `Unsupported TCI sample type: ${sampleType}`);
  }
}

export function sampleTypeName(sampleType: TciSampleType): TciSampleTypeName {
  switch (sampleType) {
    case TciSampleType.INT16:
      return 'int16';
    case TciSampleType.INT24:
      return 'int24';
    case TciSampleType.INT32:
      return 'int32';
    case TciSampleType.FLOAT32:
      return 'float32';
    default:
      throw new TciError('invalid-frame', `Unsupported TCI sample type: ${sampleType}`);
  }
}

export function normalizeSampleType(sampleType: TciSampleType | TciSampleTypeName | number): TciSampleType {
  if (typeof sampleType === 'string') {
    switch (sampleType.toLowerCase()) {
      case 'int16':
        return TciSampleType.INT16;
      case 'int24':
        return TciSampleType.INT24;
      case 'int32':
        return TciSampleType.INT32;
      case 'float32':
        return TciSampleType.FLOAT32;
      default:
        throw new TciError('invalid-frame', `Unsupported TCI sample type: ${sampleType}`);
    }
  }
  if (sampleType >= TciSampleType.INT16 && sampleType <= TciSampleType.FLOAT32) {
    return sampleType as TciSampleType;
  }
  throw new TciError('invalid-frame', `Unsupported TCI sample type: ${sampleType}`);
}

export function normalizeStreamType(streamType: TciStreamType | number): TciStreamType {
  if (streamType >= TciStreamType.IQ_STREAM && streamType <= TciStreamType.LINEOUT_STREAM) {
    return streamType as TciStreamType;
  }
  throw new TciError('invalid-frame', `Unsupported TCI stream type: ${streamType}`);
}

export function payloadToFloat32(frameOrPayload: TciStreamFrame | Buffer | Uint8Array, sampleType?: TciSampleType | TciSampleTypeName): Float32Array {
  const payload = isFrame(frameOrPayload) ? frameOrPayload.payload : toBuffer(frameOrPayload);
  const type = isFrame(frameOrPayload) ? frameOrPayload.sampleType : normalizeSampleType(sampleType ?? TciSampleType.FLOAT32);
  const bytes = sampleTypeBytes(type);
  if (payload.byteLength % bytes !== 0) {
    throw new TciError('invalid-frame', 'Payload length is not aligned to sample type');
  }

  const output = new Float32Array(payload.byteLength / bytes);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < output.length; i += 1) {
    const offset = i * bytes;
    switch (type) {
      case TciSampleType.INT16:
        output[i] = view.getInt16(offset, true) / 32768;
        break;
      case TciSampleType.INT24:
        output[i] = readInt24(view, offset) / 8388608;
        break;
      case TciSampleType.INT32:
        output[i] = view.getInt32(offset, true) / 2147483648;
        break;
      case TciSampleType.FLOAT32:
        output[i] = view.getFloat32(offset, true);
        break;
    }
  }
  return output;
}

export function samplesToPayload(samples: Float32Array | readonly number[], sampleType: TciSampleType | TciSampleTypeName): Buffer {
  const type = normalizeSampleType(sampleType);
  const bytes = sampleTypeBytes(type);
  const payload = Buffer.alloc(samples.length * bytes);
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < samples.length; i += 1) {
    const value = clampSample(samples[i] ?? 0);
    const offset = i * bytes;
    switch (type) {
      case TciSampleType.INT16:
        view.setInt16(offset, Math.round(value * 32767), true);
        break;
      case TciSampleType.INT24:
        writeInt24(view, offset, Math.round(value * 8388607));
        break;
      case TciSampleType.INT32:
        view.setInt32(offset, Math.round(value * 2147483647), true);
        break;
      case TciSampleType.FLOAT32:
        view.setFloat32(offset, value, true);
        break;
    }
  }
  return payload;
}

export function pcm16ToFloat32(input: Buffer | Uint8Array | Int16Array): Float32Array {
  if (input instanceof Int16Array) {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      output[i] = input[i] / 32768;
    }
    return output;
  }
  return payloadToFloat32(toBuffer(input), TciSampleType.INT16);
}

export function float32ToPcm16(samples: Float32Array | readonly number[]): Buffer {
  return samplesToPayload(samples, TciSampleType.INT16);
}

export function deinterleaveChannels(samples: Float32Array, channels: number): Float32Array[] {
  if (channels <= 0 || samples.length % channels !== 0) {
    throw new TciError('invalid-frame', 'Cannot deinterleave samples with invalid channel count');
  }
  const frames = samples.length / channels;
  const outputs = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      outputs[channel][frame] = samples[frame * channels + channel];
    }
  }
  return outputs;
}

export function mixToMono(samples: Float32Array, channels: number): Float32Array {
  if (channels === 1) {
    return samples;
  }
  const separated = deinterleaveChannels(samples, channels);
  const mono = new Float32Array(separated[0]?.length ?? 0);
  for (const channel of separated) {
    for (let i = 0; i < mono.length; i += 1) {
      mono[i] += channel[i] / channels;
    }
  }
  return mono;
}

function toBuffer(input: Buffer | Uint8Array | ArrayBuffer | ArrayBufferView): Buffer {
  if (Buffer.isBuffer(input)) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return Buffer.from(input);
  }
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  return Buffer.from(input);
}

function isFrame(value: unknown): value is TciStreamFrame {
  return Boolean(value && typeof value === 'object' && 'payload' in value && 'sampleType' in value);
}

function clampSample(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(-1, Math.min(1, value));
}

function readInt24(view: DataView, offset: number): number {
  const value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
  return value & 0x800000 ? value | 0xff000000 : value;
}

function writeInt24(view: DataView, offset: number, value: number): void {
  const clamped = Math.max(-8388608, Math.min(8388607, value));
  view.setUint8(offset, clamped & 0xff);
  view.setUint8(offset + 1, (clamped >> 8) & 0xff);
  view.setUint8(offset + 2, (clamped >> 16) & 0xff);
}
