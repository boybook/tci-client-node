# tci-client-node

A pure TypeScript client for the Expert Electronics TCI (Transceiver Control Interface) protocol used by SunSDR and ExpertSDR.

TCI is a WebSocket protocol: text commands are used for CAT-style radio control, and binary WebSocket frames carry audio/IQ stream blocks. This package therefore does not require a native Node.js addon.

## Status

`0.1.x` focuses on the subset needed by application integrations:

- WebSocket lifecycle and READY/startup state handling
- Frequency, mode, PTT, tune, drive, split, and CW text/macros
- RX and TX sensor state parsing
- RX audio, TX audio, TX_CHRONO, and line-out stream frame parsing/building
- Serial command queue with timeout, cancellation, and interleaved broadcast handling
- Mock TCI server and fake WebSocket transport for integration tests

Panadapter, IQ UI, skimmer, and spots APIs are intentionally out of scope for the first release, but the protocol layer is designed to be extended.

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
  client.sendTxAudioForChrono(request, new Float32Array(request.sampleCount * request.channels));
});

await client.connect();
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

## Subpath Exports

- `tci-client-node`: `TciClient`, `createTciClient`, high-level radio/audio API, errors, and core types.
- `tci-client-node/protocol`: text command parser/formatter, escaping helpers, and command queue.
- `tci-client-node/audio`: stream frame parser/builder and sample conversion helpers.
- `tci-client-node/testing`: `MockTciServer` and `FakeWebSocket` helpers for tests.

## Audio Frames

The official TCI `Stream` header is 16 little-endian `uint32` fields. In this package:

- `sampleCount` maps to the official `Stream.length` field from the header.
- `payloadLength` is the actual byte length after the 64-byte header. `TX_CHRONO` frames are valid with no payload.
- `channels` is read from the TCI 1.9+ header. If a legacy 1.8-style frame has no channel field, the parser infers it from payload size.

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

The workflow mirrors the `icom-wlan-node` release shape: install with `npm ci`,
typecheck, build, test, verify the package contents, and publish to npm using
the `NPM_TOKEN` repository secret. Provenance is enabled through npm's
`publishConfig`.

## References

- [ExpertSDR3 TCI protocol](https://github.com/ExpertSDR3/TCI)
- [ftl/tci](https://github.com/ftl/tci)
- [ftl/tciadapter](https://github.com/ftl/tciadapter)

## License

MIT
