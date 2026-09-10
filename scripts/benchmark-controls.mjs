// Run with --expose-gc. The optional argument selects an unchanged baseline build.
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createFakeWebSocketImpl } from '../dist/testing/index.js';

const entry = process.argv[2] ? pathToFileURL(resolve(process.argv[2])).href : new URL('../dist/index.js', import.meta.url).href;
const { TciClient, TciTxAudioSync, TciSampleType, TciStreamType, buildStreamFrame, payloadToFloat32 } = await import(entry);
let socket;
const client = new TciClient({ url: 'ws://benchmark.invalid', WebSocketImpl: createFakeWebSocketImpl((s) => {
  socket = s;
  s.on('open', () => queueMicrotask(() => s.receive('PROTOCOL:ExpertSDR3,2.0;DEVICE:SunSDR2DX;TRX_COUNT:2;CHANNEL_COUNT:2;VFO:0,0,14074000;MODULATION:0,DIGU;MON_ENABLE:true;RX_VOLUME:0,0,-12;DRIVE:0,30;READY;')));
}) });
await client.connect();
const audio = Float32Array.from({ length: 120 }, (_, i) => Math.sin(i * 0.17) * 0.25);
const iq = Float32Array.from({ length: 1920 }, (_, i) => Math.sin(i * 0.03) * 0.25);
const lineout = Float32Array.from({ length: 960 }, (_, i) => Math.sin(i * 0.05) * 0.25);
const frame = (streamType, sampleRate, channels, samples, sampleCount) => buildStreamFrame({
  receiver: 0, sampleRate, channels, sampleType: TciSampleType.FLOAT32, streamType,
  ...(samples ? { samples } : { payload: Buffer.alloc(0), sampleCount }),
});
const frames = [frame(TciStreamType.RX_AUDIO_STREAM, 12000, 1, audio),
  frame(TciStreamType.IQ_STREAM, 96000, 2, iq), frame(TciStreamType.LINEOUT_STREAM, 48000, 2, lineout),
  frame(TciStreamType.TX_CHRONO, 12000, 1, undefined, 120)];
const sync = new TciTxAudioSync({ sampleRate: 12000, channels: 1, sampleType: TciSampleType.FLOAT32, samplesPerFrame: 120 });
sync.begin();
const counts = { rx: 0, iq: 0, lineout: 0, chrono: 0 };
let digest = 0;
client.on('rxAudioFrame', (f) => { counts.rx++; digest += payloadToFloat32(f)[1]; });
client.on('iqFrame', () => { counts.iq++; });
client.on('lineoutAudioFrame', (f) => {
  counts.lineout++;
  const values = payloadToFloat32(f);
  const mono = new Float32Array(values.length / 2);
  for (let i = 0; i < mono.length; i++) mono[i] = (values[i * 2] + values[i * 2 + 1]) / 2;
  digest += mono[1];
});
client.on('txChrono', (request) => { counts.chrono++; client.sendTxAudioForChrono(request, sync.serviceChrono(request).samples); });
let tick = 0;
function pump() {
  sync.push(audio);
  for (const f of frames) socket.receive(f, true);
  socket.receive('RX_CHANNEL_SENSORS:0,0,-75;TX_SENSORS:0,-20,10,12,1.2;');
  if (tick++ % 25 === 0) socket.receive(`RX_VOLUME:0,0,${tick % 2 ? -12 : -24};`);
  socket.sentMessages.length = 0;
}
async function run(ticks) {
  for (let i = 0; i < ticks; i++) { pump(); await delay(10); }
}
await run(200);
global.gc?.();
const heapStart = process.memoryUsage().heapUsed;
const before = { ...counts };
const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
const cpuStart = process.cpuUsage(); const start = performance.now();
await run(800);
const wallMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
loop.disable(); global.gc?.();
const result = { entry, wallMs, cpuPercent: (cpu.user + cpu.system) / (wallMs * 10),
  heapBytes: process.memoryUsage().heapUsed, heapGrowthBytes: process.memoryUsage().heapUsed - heapStart,
  eventLoopP95Ms: loop.percentile(95) / 1e6,
  counts: Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key]])),
  underflowFrames: sync.snapshot().underflowFrames, digest };
await client.disconnect();
process.stdout.write(`${JSON.stringify(result)}\n`);
