# tci-client-node

A pure TypeScript client for the Expert Electronics TCI (Transceiver Control Interface) protocol used by SunSDR and ExpertSDR.

TCI is a WebSocket protocol: text commands are used for CAT-style radio control, and binary WebSocket frames carry audio/IQ stream blocks. This package therefore does not require a native Node.js addon.

## Status

`0.3.x` provides a dialect-aware client for application integrations:

- Strict WebSocket and READY/startup handshake validation
- Automatic ExpertSDR 1.4, 1.5-1.8, 1.9-2.0, AetherSDR, and Thetis dialect selection
- Manual and externally registered dialect implementations
- Frequency, mode, PTT, tune, drive, split, and CW text/macros
- RX and TX sensor state parsing
- RX audio, TX audio, TX_CHRONO, and line-out stream frame parsing/building
- Standard IQ capability discovery, DDS tracking, sample-rate readback, and owned IQ stream sessions
- Owned RX/TX meter sessions with typed dBm, RMS/peak power, SWR, and dialect extensions
- Serial command queue with timeout, cancellation, and interleaved broadcast handling
- Mock TCI server and fake WebSocket transport for integration tests

Panadapter rendering, skimmer DSP, and spots APIs remain application concerns; this package exposes the standard IQ transport without imposing a spectrum implementation.

## Install

```bash
npm install tci-client-node
```

## Basic Usage

```ts
import { TciClient } from 'tci-client-node';

const client = new TciClient({
  url: 'ws://127.0.0.1:40001',
  receiver: 0,
  trx: 0,
  vfo: 0,
  connectTimeoutMs: 5000,
  commandTimeoutMs: 1000,
});

client.on('state', (state) => {
  console.log(state.connected, state.ready, state.frequencies);
});

client.on('rxAudioFrame', (frame) => {
  console.log(frame.sampleRate, frame.channels, frame.sampleCount);
});

client.on('txChrono', (request) => {
  // The host application decides what to transmit.
  // Send silence if no TX audio is ready.
  client.sendTxAudioForChrono(request, new Float32Array(request.sampleCount));
});

const handshake = await client.connect();
console.log(handshake.identity, handshake.dialect.dialect.id);
await client.setFrequency(14_074_000);
await client.setMode('digu');
await client.configureAudio({
  sampleRate: 12_000,
  sampleType: 'float32',
  channels: 1,
  samplesPerFrame: 512,
});
await client.startAudio();
await client.setPtt(true, { source: 'tci' });
```

## IQ Streams

```ts
import { decodeInterleavedIq } from 'tci-client-node';

const capabilities = client.getIqCapabilities();
if (capabilities.supported) {
  const iq = await client.openIqStream({ receiver: 0, sampleRate: 96_000 });
  iq.on('frame', (event) => {
    const interleaved = decodeInterleavedIq(event.frame);
    console.log(event.centerFrequency, event.sampleRate, interleaved.length / 2);
  });

  const applied = await iq.setSampleRate(48_000);
  console.log(applied.requested, applied.applied);
  await iq.close();
}
```

`openIqStream()` resolves on the first valid IQ frame rather than relying on an `IQ_START` echo, because some compatible servers intentionally do not echo that command. The returned session owns the subscription and sends best-effort `IQ_STOP` when closed.

## Meter Streams

```ts
const meters = await client.openMeterStream({ receiver: 0, channel: 0, trx: 0, intervalMs: 300 });

meters.on('rxFrame', (frame) => {
  console.log(frame.levelDbm, frame.averageLevelDbm, frame.peakBinDbm);
});

meters.on('txFrame', (frame) => {
  console.log(frame.rmsPowerWatts, frame.peakPowerWatts, frame.swr, frame.alc);
});

meters.on('capabilitiesChanged', (capabilities) => {
  console.log(capabilities.rxLevel, capabilities.txRmsPower);
});

await meters.close();
```

Meter support progresses from dialect declarations and enable acknowledgements to `observed` only after a valid field arrives. `RX_SENSORS`, `RX_CHANNEL_SENSORS`, and Thetis `RX_CHANNEL_SENSORS_EX` are coalesced into one richest RX frame. AetherSDR's trailing TX ALC field is exposed with its native `dbfs` unit. The session sends best-effort RX/TX disable commands when closed and never waits for a TX frame while the radio is idle.

`connect()` resolves only after a valid `READY;` initialization sequence. A WebSocket that opens but does not provide enough TCI initialization evidence is rejected. Use `dialect: 'thetis-2.0'` or another dialect ID only when an incomplete server cannot be identified automatically.

## Dialects

The high-level client delegates command shapes and binary stream semantics to a `TciDialect`. Built-in dialects are `expertsdr-1.4`, `expertsdr-1.5-1.8`, `expertsdr-1.9-2.0`, `aethersdr-1.5`, `thetis-2.0`, and `generic-observed`.

`generic-observed` derives legacy versus TRX-indexed `DRIVE` syntax from startup state. Applications can provide a custom dialect directly or use a custom `TciDialectRegistry`.

## Power Writes

Servers may apply a local band or PA safety limit and broadcast a different drive value. Use the detailed result when the difference matters:

```ts
const result = await client.setDriveWithResult(100);
// { requested: 100, applied: 50, outcome: 'clamped', acknowledgement: 'state' }
```

The compatibility `setDrive()` method remains available and treats a clamped value as a successful write rather than a timeout.

## Subpath Exports

- `tci-client-node`: `TciClient`, `createTciClient`, high-level radio/audio API, errors, and core types.
- `tci-client-node/protocol`: text command parser/formatter, escaping helpers, and command queue.
- `tci-client-node/audio`: stream frame parser/builder and sample conversion helpers.
- `tci-client-node/dialect`: dialect interfaces, built-ins, detection, and registry.
- `tci-client-node/transport`: transport interface and default WebSocket transport.
- `tci-client-node/meter`: meter adapters, capability types, frames, and session API.
- `tci-client-node/testing`: `MockTciServer` and `FakeWebSocket` helpers for tests.

## Audio Frames

The official TCI `Stream` header is 16 little-endian `uint32` fields. In this package:

- `headerSampleCount` is the raw `Stream.length` field.
- `sampleCount` is the canonical scalar value count across all channels.
- `frameCount` is `sampleCount / channels`.
- `payloadLength` is the actual byte length after the 64-byte header. `TX_CHRONO` frames are valid with no payload.
- Modern TCI uses scalar length semantics. Legacy dialects use per-channel length semantics and may omit the channel field; the selected dialect supplies the required context.

Supported sample types are `int16`, `int24`, `int32`, and `float32`.

## Testing Utilities

```ts
import { MockTciServer } from 'tci-client-node/testing';

const server = new MockTciServer();
await server.start();

const client = new TciClient({ url: server.url() });
await client.connect();

server.sendRxAudioFrame({ samples: new Float32Array([0, 0.5, -0.5]) });
```

## Development

```bash
npm install
npm test
npm run typecheck
npm run build
```

The package is built with `tsup` and publishes ESM, CommonJS, and declaration files.

## Releases

Releases are published by GitHub Actions when a `v*` tag is pushed. The tag must
match `package.json` exactly, for example `v0.1.0` for version `0.1.0`.

The workflow installs with `npm ci`, typechecks, builds, tests, verifies package
contents, and publishes through npm Trusted Publishing (OIDC) with provenance.

## References

- [ExpertSDR3 TCI protocol](https://github.com/ExpertSDR3/TCI)
- [ftl/tci](https://github.com/ftl/tci)
- [ftl/tciadapter](https://github.com/ftl/tciadapter)

## License

MIT
