# Changelog

## 0.4.0

- Add owned RX/TX meter stream sessions and progressive capability states.
- Add dialect adapters for ExpertSDR, Thetis, AetherSDR, and generic observed servers.
- Parse and coalesce legacy, channel, and extended RX sensor frames.
- Expose standard TX RMS/peak power and SWR plus AetherSDR's native dBFS ALC extension.
- Validate malformed meter frames and perform best-effort subscription cleanup.
- Extend the mock TCI server with typed RX/TX meter helpers.

## 0.3.0

- Add standard TCI IQ capability discovery and dialect-specific sample-rate lists.
- Track IQ sample-rate, receiver lifecycle, and DDS center-frequency state.
- Add owned IQ stream sessions with first-frame startup acknowledgement and sample-rate readback.
- Emit typed IQ frames and add interleaved I/Q decoding helpers.
- Extend the mock TCI server with standard IQ frames and lifecycle commands.

## 0.2.0

- Add an extensible TCI transport, dialect registry, strict handshake, and protocol identity model.
- Support ExpertSDR TCI 1.4 through 2.0, AetherSDR's 1.5 hybrid protocol, Thetis 2.0, and observed legacy command shapes.
- Treat constrained drive acknowledgements as successful clamped writes and add active drive readback.
- Correct scalar versus per-channel `Stream.length` handling for mono, stereo, legacy, and modern streams.
- Track negotiated audio parameters and expose dialect-aware handshake diagnostics.
