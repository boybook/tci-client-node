import { afterEach, describe, expect, it, vi } from 'vitest';
import { TciClient, type TciControlId, type TciControlValue, type TciControlState } from '../src/index.js';
import { createFakeWebSocketImpl, type FakeWebSocket } from '../src/testing/index.js';

const clients: TciClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((c) => c.disconnect())); });

async function connect(vendor = 'expert', state: string[] = []) {
  let socket!: FakeWebSocket;
  const identity = vendor === 'thetis' ? 'PROTOCOL:Thetis,2.0;DEVICE:ANAN7000DLE;'
    : vendor === 'aether' ? 'PROTOCOL:ExpertSDR3,1.5;DEVICE:AetherSDR;'
      : vendor === 'unknown' ? 'PROTOCOL:ExpertSDR3,2.0;DEVICE:UnidentifiedCompatibleServer;'
        : 'PROTOCOL:ExpertSDR3,2.0;DEVICE:SunSDR2DX;';
  const client = new TciClient({ url: 'ws://test.invalid', commandTimeoutMs: 80,
    WebSocketImpl: createFakeWebSocketImpl((s) => {
      socket = s;
      s.on('open', () => queueMicrotask(() => s.receive(`${identity}TRX_COUNT:2;CHANNEL_COUNT:2;MODULATIONS_LIST:USB,LSB,DIGU;VFO:0,0,14074000;${state.join('')}READY;`)));
    }),
  });
  clients.push(client);
  await client.connect();
  const sent = () => socket.sentMessages.map((message) => String(message.data));
  return { client, socket, sent };
}

// Literal protocol/capture examples, independent of the adapter's formatter and tables.
const official: [TciControlId, string, TciControlValue][] = [
  ['volume', 'VOLUME:-12;', -12], ['mute', 'MUTE:true;', true],
  ['rx_volume', 'RX_VOLUME:0,0,-6;', -6], ['rx_mute', 'RX_MUTE:0,false;', false],
  ['rx_balance', 'RX_BALANCE:0,0,-12;', -12], ['mon_enable', 'MON_ENABLE:true;', true],
  ['mon_volume', 'MON_VOLUME:-30;', -30], ['agc_mode', 'AGC_MODE:0,normal;', 'normal'],
  ['agc_gain', 'AGC_GAIN:0,87;', 87], ['sql_enable', 'SQL_ENABLE:0,true;', true],
  ['sql_level', 'SQL_LEVEL:0,-83;', -83], ['rx_nb_enable', 'RX_NB_ENABLE:0,true;', true],
  ['rx_nb_param', 'RX_NB_PARAM:0,70,25;', { threshold: 70, pulseLength: 25 }],
  ['rx_nr_enable', 'RX_NR_ENABLE:0,true;', true], ['rx_anc_enable', 'RX_ANC_ENABLE:0,true;', true],
  ['rx_anf_enable', 'RX_ANF_ENABLE:0,true;', true], ['rx_apf_enable', 'RX_APF_ENABLE:0,true;', true],
  ['rx_nf_enable', 'RX_NF_ENABLE:0,true;', true], ['rx_bin_enable', 'RX_BIN_ENABLE:0,true;', true],
  ['rx_dse_enable', 'RX_DSE_ENABLE:0,true;', true],
  ['rx_filter_band', 'RX_FILTER_BAND:0,-2900,-70;', { lowHz: -2900, highHz: -70 }],
  ['rit_enable', 'RIT_ENABLE:0,true;', true], ['rit_offset', 'RIT_OFFSET:0,500;', 500],
  ['xit_enable', 'XIT_ENABLE:0,true;', true], ['xit_offset', 'XIT_OFFSET:0,-350;', -350],
  ['digl_offset', 'DIGL_OFFSET:1500;', 1500], ['digu_offset', 'DIGU_OFFSET:2200;', 2200],
  ['cw_macros_speed', 'CW_MACROS_SPEED:42;', 42], ['cw_macros_delay', 'CW_MACROS_DELAY:100;', 100],
  ['cw_keyer_speed', 'CW_KEYER_SPEED:35;', 35], ['lock', 'LOCK:0,true;', true],
  ['tx_enable', 'TX_ENABLE:0,true;', true], ['tx_frequency', 'TX_FREQUENCY:7140000;', 7140000],
  ['drive', 'DRIVE:0,75;', 75], ['tune_drive', 'TUNE_DRIVE:0,30;', 30],
  ['split_enable', 'SPLIT_ENABLE:0,true;', true],
];

describe('official control state', () => {
  it.each(official)('decodes %s from startup and broadcasts', async (id, wire, value) => {
    const { client, socket, sent } = await connect('expert', [wire]);
    expect(client.getControlState(id)?.value).toEqual(value);
    expect(sent()).toEqual([]);
    const changed = vi.fn(); client.on('controlChanged', changed);
    socket.receive(wire.toLowerCase());
    expect(changed).not.toHaveBeenCalled();
    expect(client.getControlState(id)?.source).toBe('broadcast');
  });

  it('ignores malformed values and other channels without corrupting state', async () => {
    const { client, socket } = await connect('expert', ['RX_VOLUME:0,0,-12;']);
    socket.receive('RX_VOLUME:0,0,NaN;RX_VOLUME:0,0,Infinity;RX_VOLUME:0,0,;RX_VOLUME:-1,0,0;RX_VOLUME:0,1,-6;MON_ENABLE:1;');
    expect(client.getControlState('rx_volume')?.value).toBe(-12);
    expect(client.getControlState('mon_enable')).toBeUndefined();
    expect(client.getControlState('rx_volume', { scope: 'channel', receiver: 0, channel: 1 })?.value).toBe(-6);
  });

  it('returns detached values and leaves unsupported identities unknown despite echoes', async () => {
    const { client, socket, sent } = await connect('unknown', ['RX_NB_ENABLE:0,true;']);
    socket.receive('RX_NB_ENABLE:0,true;');
    expect(client.getControlState('rx_nb_enable')).toBeUndefined();
    expect(() => client.readControl('rx_nb_enable')).toThrow(/not implemented/);
    await expect(client.writeControl('rx_nb_enable', true)).rejects.toMatchObject({ code: 'unsupported-control' });
    expect(sent()).toEqual([]);
  });
});

describe('control transactions', () => {
  it('keeps the legacy void passband setter strict while retaining the actual clamped band', async () => {
    const { client, socket } = await connect();
    socket.on('sent', (raw) => { if (String(raw).startsWith('RX_FILTER_BAND:')) socket.receive('RX_FILTER_BAND:0,-2800,-100;'); });
    await expect(client.setRxFilterBand(-3200, -100)).rejects.toMatchObject({ code: 'control-rejected' });
    expect(client.getState().rxFilterBands['0']).toEqual([-2800, -100]);
  });
  it('invalidates removed receiver state and refuses writes before a fallback target can be used', async () => {
    const { client, socket, sent } = await connect('aether', ['RX_VOLUME:1,70;']);
    const target = { scope: 'receiver', receiver: 1 } as const;
    socket.receive('TRX_COUNT:1;');
    expect(client.getControlState('rx_volume', target)?.availability).toBe('unavailable');
    await expect(client.writeControl('rx_volume', 30, target)).rejects.toMatchObject({ code: 'invalid-control-value' });
    expect(sent()).toEqual([]);
    socket.receive('TRX_COUNT:2;');
    expect(client.getControlState('rx_volume', target)?.availability).toBe('unavailable');
    socket.receive('RX_VOLUME:1,50;');
    expect(client.getControlState('rx_volume', target)).toMatchObject({ availability: 'available', value: 50 });
  });
  it('preserves fractional dB when the protocol does not declare an integer step', async () => {
    const { client, socket, sent } = await connect();
    socket.on('sent', (raw) => socket.receive(String(raw)));
    await client.writeControl('rx_volume', -12.35);
    expect(sent()).toEqual(['RX_VOLUME:0,0,-12.35;']);
    expect(client.getControlState('rx_volume')?.value).toBe(-12.35);
  });
  it.each(official.filter(([id]) => !['tx_enable', 'tx_frequency'].includes(id)))(
    'writes and queries the official %s wire shape', async (id, wire, value) => {
      const { client, socket, sent } = await connect();
      const global = ['volume', 'mute', 'mon_enable', 'mon_volume', 'digl_offset', 'digu_offset',
        'cw_macros_speed', 'cw_macros_delay', 'cw_keyer_speed'].includes(id);
      const channel = ['rx_volume', 'rx_balance'].includes(id);
      const query = `${wire.split(':')[0]}${global ? '' : channel ? ':0,0' : ':0'};`;
      socket.on('sent', (raw) => { if (raw === wire || raw === query) socket.receive(wire); });
      await client.writeControl(id, value);
      expect(sent()[0]).toBe(wire);
      if (id !== 'cw_keyer_speed') {
        expect((await client.readControl(id)).value).toEqual(value);
        expect(sent()[1]).toBe(query);
      }
    },
  );

  it('keeps listeners bounded over 100 reconnects and cancels fallback timers', async () => {
    const { client } = await connect();
    const changed = vi.fn(); client.on('controlChanged', changed);
    for (let i = 0; i < 100; i += 1) {
      await client.disconnect();
      await client.connect();
      expect(client.listenerCount('controlChanged')).toBe(1);
    }
    const controller = new AbortController();
    const pending = client.writeControl('volume', -12, undefined, { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    controller.abort(); await assertion;
    expect(client.getControlState('volume')).toBeUndefined();
  });
  it('coalesces concurrent reads and validates the exact reply target', async () => {
    const { client, socket, sent } = await connect();
    socket.on('sent', (raw) => {
      if (raw === 'RX_VOLUME:0,0;') queueMicrotask(() => socket.receive('RX_VOLUME:0,1,-5;RX_VOLUME:0,0,-19;'));
    });
    const [one, two] = await Promise.all([client.readControl('rx_volume'), client.readControl('rx_volume')]);
    expect(one.value).toBe(-19); expect(two.value).toBe(-19);
    expect(sent()).toEqual(['RX_VOLUME:0,0;']);
  });

  it('does not accept old or unrelated state as a fresh exact write confirmation', async () => {
    const { client, socket } = await connect('expert', ['RX_NR_ENABLE:0,false;']);
    socket.on('sent', (raw) => {
      if (raw === 'RX_NR_ENABLE:0,true;') {
        socket.receive('RX_NR_ENABLE:0,false;RX_NR_ENABLE:1,true;');
        setTimeout(() => socket.receive('RX_NR_ENABLE:0,true;'), 10);
      }
    });
    await expect(client.writeControl('rx_nr_enable', true)).resolves.toMatchObject({ applied: true, acknowledgement: 'state' });
  });

  it('queries once after a missing SET echo without resending the write', async () => {
    const { client, socket, sent } = await connect();
    socket.on('sent', (raw) => { if (raw === 'VOLUME;') socket.receive('VOLUME:-24;'); });
    await expect(client.writeControl('volume', -25)).resolves.toMatchObject({ requested: -25, applied: -24, outcome: 'clamped', acknowledgement: 'readback' });
    expect(sent()).toEqual(['VOLUME:-25;', 'VOLUME;']);
  });

  it('rejects a refused boolean write and retains the socket', async () => {
    const { client, socket } = await connect();
    socket.on('sent', (raw) => { if (raw === 'MON_ENABLE;') socket.receive('MON_ENABLE:false;'); });
    await expect(client.writeControl('mon_enable', true)).rejects.toMatchObject({ code: 'control-rejected' });
    expect(client.isConnected()).toBe(true);
  });

  it('serializes a fallback query before the next control transaction', async () => {
    const { client, socket, sent } = await connect();
    socket.on('sent', (raw) => {
      if (raw === 'VOLUME;') socket.receive('VOLUME:-25;');
      if (raw === 'MON_ENABLE:true;') socket.receive('MON_ENABLE:true;');
    });
    await Promise.all([client.writeControl('volume', -25), client.writeControl('mon_enable', true)]);
    expect(sent()).toEqual(['VOLUME:-25;', 'VOLUME;', 'MON_ENABLE:true;']);
  });

  it('rejects incomplete/invalid groups and writes a passband as one command', async () => {
    const { client, socket, sent } = await connect();
    for (const value of [{ lowHz: -30 }, { lowHz: 100, highHz: -100 }, { lowHz: NaN, highHz: 100 }, { lowHz: 0, highHz: 100, extra: 1 }]) {
      await expect(client.writeControl('rx_filter_band', value as never)).rejects.toMatchObject({ code: 'invalid-control-value' });
    }
    socket.on('sent', (raw) => socket.receive(String(raw)));
    await client.writeControl('rx_filter_band', { lowHz: -3000, highHz: 3000 });
    expect(sent()).toEqual(['RX_FILTER_BAND:0,-3000,3000;']);
    expect(client.getState().rxFilterBands['0']).toEqual([-3000, 3000]);
    const state = client.getControlState('rx_filter_band')!;
    state.value!.lowHz = 999;
    expect(client.getControlState('rx_filter_band')!.value!.lowHz).toBe(-3000);
  });

  it('marks write-only CW speed as sent without fabricating readback', async () => {
    const { client, sent } = await connect();
    await expect(client.writeControl('cw_keyer_speed', 32)).resolves.toMatchObject({ applied: null, outcome: 'sent', acknowledgement: 'sent' });
    expect(sent()).toEqual(['CW_KEYER_SPEED:32;']);
    expect(client.getControlState('cw_keyer_speed')).toBeUndefined();
    await expect(client.readControl('cw_keyer_speed')).rejects.toMatchObject({ code: 'unsupported-control' });
  });

  it('rejects writes to notifications and the primary channel before sending', async () => {
    const { client, sent } = await connect();
    for (const id of ['tx_enable', 'vfo_lock', 'rx_channel_enable', 'rx_enable'] as const) {
      await expect(client.writeControl(id, false)).rejects.toMatchObject({ code: 'unsupported-control' });
    }
    await expect(client.writeControl('rx_volume', -10, { scope: 'channel', receiver: 0, channel: 2 })).rejects.toMatchObject({ code: 'invalid-control-value' });
    expect(sent()).toEqual([]);
  });

  it('cancels pending reads and prevents late old-session updates', async () => {
    const { client, socket } = await connect();
    const pending = client.readControl('volume');
    const assertion = expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    await client.disconnect(); await assertion;
    socket.receive('VOLUME:-6;');
    expect(client.getControlState('volume')).toBeUndefined();
  });
});

describe('vendor controls', () => {
  it('does not expose transmitter settings for a receive-only device', async () => {
    const { client, sent } = await connect('expert', ['RECEIVE_ONLY:true;']);
    await expect(client.writeControl('drive', 10)).rejects.toMatchObject({ code: 'unsupported-control' });
    expect(client.getControlCapabilities().find((d) => d.id === 'mon_enable')?.support).toBe('unsupported');
    expect(client.getControlCapabilities().find((d) => d.id === 'rx_volume')?.support).toBe('implemented');
    expect(sent()).toEqual([]);
  });
  it('recognizes Thetis controls while its protocol and device identities emulate ExpertSDR', async () => {
    const { client } = await connect('expert', ['TX_PROFILES_EX:SSB,Digital;', 'TX_PROFILE_EX:SSB;',
      'CALIBRATION_EX:0,0,0,0,0,0;', 'RX_NR_ENABLE_EX:0,true,4;']);
    expect(client.getState().dialectId).toBe('thetis-2.0');
    expect(client.getControlState('rx_nr_algorithm')?.value).toBe(4);
  });
  it('uses Aether single-index percent queries without changing the modeled volume', async () => {
    const { client, socket, sent } = await connect('aether');
    let volume = 75;
    socket.on('sent', (raw) => {
      if (raw === 'RX_VOLUME:0;') socket.receive(`rx_volume:0,${volume};`);
      else if (String(raw).startsWith('RX_VOLUME:0,')) volume = Number(String(raw).split(',')[1].replace(';', ''));
    });
    expect((await client.readControl('rx_volume')).value).toBe(75);
    expect(volume).toBe(75); expect(sent()).toEqual(['RX_VOLUME:0;']);
    await client.writeControl('rx_volume', 40);
    expect(volume).toBe(40);
    expect(sent()).toEqual(['RX_VOLUME:0;', 'RX_VOLUME:0,40;', 'RX_VOLUME:0;']);
  });

  it('ignores Aether optimistic echoes and excludes placeholder DSP', async () => {
    const { client, socket } = await connect('aether');
    socket.on('sent', (raw) => {
      if (raw === 'MON_VOLUME:50;') socket.receive('MON_VOLUME:50;');
      if (raw === 'MON_VOLUME;') socket.receive('MON_VOLUME:35;');
    });
    await expect(client.writeControl('mon_volume', 50)).resolves.toMatchObject({ applied: 35, acknowledgement: 'readback' });
    for (const id of ['rx_bin_enable', 'rx_anc_enable', 'rx_dse_enable', 'rx_nf_enable'] as const) {
      socket.receive(`${id}:0,true;`);
      expect(client.getControlState(id)).toBeUndefined();
      await expect(client.writeControl(id, true)).rejects.toMatchObject({ code: 'unsupported-control' });
    }
    await expect(client.setMonitorVolumeDb(-12)).rejects.toMatchObject({ code: 'unsupported-control' });
  });

  it.each([['rx_nr_enable', 'rx_nr_algorithm', 'RX_NR_ENABLE_EX', 4], ['rx_nb_enable', 'rx_nb_algorithm', 'RX_NB_ENABLE_EX', 2]] as const)(
    'preserves Thetis selection for %s when disabled and reenabled', async (enabled, algorithm, command, selection) => {
      const { client, socket, sent } = await connect('thetis', [`${command}:0,true,${selection};`]);
      socket.on('sent', (raw) => socket.receive(String(raw)));
      await client.writeControl(enabled, false);
      expect(client.getControlState(algorithm)?.value).toBe(0);
      await client.writeControl(enabled, true);
      expect(sent()).toEqual([`${command}:0,false,0;`, `${command}:0,true,${selection};`]);
    },
  );

  it('reads Thetis algorithm through its ordinary query and validates FM choices', async () => {
    const { client, socket, sent } = await connect('thetis');
    socket.on('sent', (raw) => { if (raw === 'RX_NR_ENABLE:0;') socket.receive('RX_NR_ENABLE:0,true;RX_NR_ENABLE_EX:0,true,3;'); });
    expect((await client.readControl('rx_nr_algorithm')).value).toBe(3);
    await expect(client.writeControl('fm_deviation_ex', 3000)).rejects.toMatchObject({ code: 'invalid-control-value' });
    expect(sent()).toEqual(['RX_NR_ENABLE:0;']);
    expect(client.getControlCapabilities().find((d) => d.id === 'rx_preamp_att_ex')?.writable).toBe(false);
    expect(client.getControlCapabilities().find((d) => d.id === 'rx_nf_enable')?.writable).toBe(false);
  });

  it('updates Thetis profile options from the advertised list', async () => {
    const { client, socket } = await connect('thetis');
    socket.receive('TX_PROFILES_EX:SSB,Digital;');
    expect(client.getControlCapabilities().find((d) => d.id === 'tx_profile_ex')?.options).toEqual(['SSB', 'Digital']);
    await expect(client.writeControl('tx_profile_ex', 'Unknown')).rejects.toMatchObject({ code: 'invalid-control-value' });
  });
});
