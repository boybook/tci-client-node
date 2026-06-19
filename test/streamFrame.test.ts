import { describe, expect, it } from 'vitest';
import {
  TCI_STREAM_HEADER_BYTES,
  buildStreamFrame,
  buildTxAudioFrame,
  float32ToPcm16,
  mixToMono,
  parseStreamFrame,
  payloadToFloat32,
  pcm16ToFloat32,
  samplesToPayload,
  TciSampleType,
  TciStreamType,
} from '../src/audio/index.js';

it('parses and builds little-endian stream headers', () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1]);
  const raw = buildStreamFrame({
    receiver: 1,
    sampleRate: 12_000,
    sampleType: 'float32',
    streamType: TciStreamType.RX_AUDIO_STREAM,
    channels: 2,
    samples,
  });
  expect(raw.readUInt32LE(5 * 4)).toBe(2);
  const frame = parseStreamFrame(raw);
  expect(frame.receiver).toBe(1);
  expect(frame.sampleRate).toBe(12_000);
  expect(frame.sampleType).toBe(TciSampleType.FLOAT32);
  expect(frame.streamType).toBe(TciStreamType.RX_AUDIO_STREAM);
  expect(frame.channels).toBe(2);
  expect(frame.payloadLength).toBe(samples.byteLength);
  expect(frame.sampleCount).toBe(2);
  expect(Array.from(payloadToFloat32(frame))).toEqual(Array.from(samples));
});

it('validates payload length against sample type and channels', () => {
  const raw = buildStreamFrame({
    sampleRate: 12_000,
    sampleType: 'int16',
    streamType: TciStreamType.RX_AUDIO_STREAM,
    channels: 2,
    payload: Buffer.alloc(4),
  });
  const truncated = Buffer.concat([raw.subarray(0, TCI_STREAM_HEADER_BYTES), Buffer.alloc(3)]);
  expect(() => parseStreamFrame(truncated)).toThrow(/length mismatch|aligned/);
});

it('infers channels from legacy 1.8-style headers without the channels field', () => {
  const raw = buildStreamFrame({
    sampleRate: 12_000,
    sampleType: 'float32',
    streamType: TciStreamType.RX_AUDIO_STREAM,
    channels: 2,
    samples: new Float32Array([0, 0.25, 0.5, 0.75]),
  });
  raw.writeUInt32LE(0, 7 * 4);
  const frame = parseStreamFrame(raw);
  expect(frame.channels).toBe(2);
  expect(frame.sampleCount).toBe(2);
});

it('converts int16/int24/int32/float32 payloads to float32', () => {
  const samples = [0, 0.25, -0.25, 1, -1];
  for (const type of ['int16', 'int24', 'int32', 'float32'] as const) {
    const payload = samplesToPayload(samples, type);
    const restored = payloadToFloat32(payload, type);
    expect(restored.length).toBe(samples.length);
    expect(restored[1]).toBeCloseTo(0.25, 4);
    expect(restored[2]).toBeCloseTo(-0.25, 4);
  }
});

it('builds TX audio and mono helpers', () => {
  const tx = parseStreamFrame(buildTxAudioFrame({ sampleRate: 12_000, sampleType: 'int16', channels: 1, samples: [0, 0.5] }));
  expect(tx.streamType).toBe(TciStreamType.TX_AUDIO_STREAM);
  expect(Array.from(pcm16ToFloat32(float32ToPcm16([0, 0.5])))[1]).toBeCloseTo(0.5, 4);
  expect(Array.from(mixToMono(new Float32Array([1, -1, 0.5, 0.5]), 2))).toEqual([0, 0.5]);
});
