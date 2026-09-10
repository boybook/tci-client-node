# TCI parameter controls

Evidence date: 2026-09-10. Protocol/source validation is not a hardware compatibility claim.

The controls adapter owns command addressing, decoding, units and confirmation. Applications
own permission, physical-idle constraints, session bootstrap and polling. Binary audio, IQ,
PTT, device power and stream ownership are not parameter controls.

## Evidence

- [Official TCI 2.0, 2024-01-12](https://github.com/ExpertSDR3/TCI/blob/b081213ff97150fd29f669c633f060f93c81a286/TCI%20Protocol.pdf), pages 14–29 and 40.
- [Thetis 852bf0e](https://github.com/ramdor/Thetis/blob/852bf0ef0b4f3886a13fc2846489aee16f361872/Project%20Files/Source/Console/TCIServer.cs), including the ExpertSDR3 1.1.7 startup capture.
- [AetherSDR 8a358c5](https://github.com/aethersdr/AetherSDR/blob/8a358c5f7cfb459e86d5d7c0ad61bf110e292c06/src/core/TciProtocol.cpp) and its SliceModel/TransmitModel setters.

## Command matrix

| Family | Official native semantics | Dialect restrictions |
| --- | --- | --- |
| DRIVE / TUNE_DRIVE | TRX, 0–100 | TCI 1.4 omits TRX on wire; reported clamping is retained |
| MODULATION / SPLIT_ENABLE | Receiver mode / TRX split | Modes from MODULATIONS_LIST; split does not key PTT |
| VOLUME / MUTE | Global, −60…0 dB / boolean | Aether MUTE is receiver-scoped |
| RX_VOLUME / RX_MUTE | Receiver+channel dB / receiver boolean | Aether RX_VOLUME has one receiver index and percent values |
| RX_BALANCE | Receiver+channel, −40…40, positive toward left | Aether receiver-only −50…50, positive toward right |
| MON_ENABLE / MON_VOLUME | Global, boolean / −60…0 dB | Aether MON_VOLUME is 0–100, never dB |
| AGC_MODE / AGC_GAIN | Receiver normal/fast/off, −20…120 dB | Thetis extends enum; Aether AGC gain is read-only native units |
| SQL_ENABLE / SQL_LEVEL | Receiver boolean / −140…0 | Aether level is read-only: underlying receiver scale unknown |
| RX_NB_ENABLE / RX_NB_PARAM | Boolean / threshold 1…100 and pulseLength 1…300 | Pulse length has no documented unit. Thetis pair unsupported; Aether exposes rx_nb_level instead |
| RX_NR_ENABLE | Receiver boolean | Thetis NR algorithms 0…4; ordinary query also returns extended state |
| RX_ANC/ANF/APF/NF/BIN/DSE_ENABLE | Receiver boolean | Aether ANC/NF/BIN/DSE are placeholders and unsupported; Thetis ANC/DSE unimplemented; NF is read-only because its query and setter have different scope |
| RX_FILTER_BAND | Signed lowHz/highHz | Preserve both edges and sideband polarity |
| RIT/XIT_ENABLE/OFFSET | Receiver boolean / signed Hz | Thetis shares the underlying global value |
| DIGL/DIGU_OFFSET | Global 0…4000 Hz | Requires idle in host orchestration |
| CW_MACROS_SPEED/DELAY | Global WPM / ms | No invented upper bound |
| CW_KEYER_SPEED | Global WPM, write-only in official spec | Thetis/Aether have query support |
| RX_CHANNEL_ENABLE / RX_ENABLE | Channel/receiver enable | Primary channel/receiver is read-only; Aether enable is not writable |
| LOCK / VFO_LOCK | Tuning lock / server notification | VFO_LOCK is read-only; incompatible Aether alias excluded |
| TX_ENABLE / TX_FREQUENCY | Server notification | No write or speculative query |
| RX_NR/NB_ALGORITHM | Thetis NR1…4 / NB1…2 | Disabled=0; toggling retains last nonzero selection within this session |
| RX_STEP_ATT_* / RX_PREAMP_ATT_EX | Thetis attenuation | Enable supported; levels read-only until hardware limits/options are known |
| AGC_AUTO_EX / RX_CTUN_EX / VFO_SYNC_EX | Thetis switches | CTUN and VFO sync require host idle guard |
| VFO_SWAP_EX | Thetis action | Sent-only, requires host idle guard |
| FM_DEVIATION_EX | Thetis global, receiver-prefixed wire | Only 2500/5000 Hz |
| TX_FILTER_BAND_EX | Thetis nonnegative edges, minimum 100 Hz width | One atomic command; requires idle |
| TX_PROFILES_EX / TX_PROFILE_EX | Thetis list/current profile | Writes restricted to advertised options |
| MIC_LEVEL / TX_GAIN | Aether 0…100 | Microphone and TCI TX audio gain, not RF output power |

## Invariants

Devices declaring RECEIVE_ONLY do not advertise transmitter settings.
Unknown identities do not acquire implemented controls through echoing. Older ExpertSDR
versions only expose controls with existing compatibility evidence. Absence of a custom
control adapter leaves new controls unknown. Existing explicit low-level command APIs remain
available to protocol consumers, but are not capability discovery mechanisms.

Queries and SET/readback transactions are serialized with one bounded readback and no SET
retry. Aether writes require readback because a SET notification may precede model application.
Read-only notifications and write-only commands are distinguished. A sent-only result has no
applied value. All returned metadata and state are detached. Duplicate values do not emit
changes, while every valid observation has a new session-local revision. Disconnect clears
state, remembered algorithms, pending queries and fallback timers.

RUN_CAT_EX, recorder operations, experimental RTTY/CTCSS/E-Coder extensions and hardware
calibration writes are intentionally outside this control implementation.
