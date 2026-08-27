# Changelog

## 0.2.0

- Add an extensible TCI transport, dialect registry, strict handshake, and protocol identity model.
- Support ExpertSDR TCI 1.4 through 2.0, Thetis 2.0, and observed legacy command shapes.
- Treat constrained drive acknowledgements as successful clamped writes and add active drive readback.
- Correct scalar versus per-channel `Stream.length` handling for mono, stereo, legacy, and modern streams.
- Track negotiated audio parameters and expose dialect-aware handshake diagnostics.
