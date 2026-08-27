import { describe, expect, it } from 'vitest';
import {
  TciDialectRegistry,
  compareTciVersion,
  parseProtocolIdentity,
  parseTciText,
  parseTciVersion,
} from '../src/index.js';

function detect(startup: string) {
  const commands = parseTciText(startup);
  const identity = parseProtocolIdentity(commands);
  return new TciDialectRegistry().select({
    identity,
    commands,
    commandNames: new Set(commands.map((command) => command.name)),
  });
}

describe('TCI dialect detection', () => {
  it.each([
    ['PROTOCOL:ExpertSDR,1.4;DEVICE:SunSDR;VFO:0,0,7100000;READY;', 'expertsdr-1.4'],
    ['PROTOCOL:ExpertSDR2,1.8;DEVICE:SunSDR2PRO;VFO:0,0,7100000;READY;', 'expertsdr-1.5-1.8'],
    ['PROTOCOL:ExpertSDR3,1.10;DEVICE:SunSDR2DX;VFO:0,0,7100000;READY;', 'expertsdr-1.9-2.0'],
    ['PROTOCOL:ExpertSDR3,1.5;DEVICE:AetherSDR;AUDIO_STREAM_CHANNELS:2;VFO:0,0,7100000;READY;', 'aethersdr-1.5'],
    ['PROTOCOL:Thetis,2.0;DEVICE:ANAN7000DLE;VFO:0,0,7100000;READY;', 'thetis-2.0'],
    ['PROTOCOL:ExpertSDR3,2.0;DEVICE:SunSDR2PRO;TX_PROFILES_EX:a,b;VFO:0,0,7100000;READY;', 'thetis-2.0'],
  ])('selects %s as %s', (startup, expected) => {
    expect(detect(startup).dialect.id).toBe(expected);
  });

  it('compares 1.10 as newer than 1.9 instead of parsing it as a float', () => {
    expect(compareTciVersion(parseTciVersion('1.10')!, parseTciVersion('1.9')!)).toBeGreaterThan(0);
  });

  it('derives the legacy DRIVE shape for an unidentified server', () => {
    const result = detect('DEVICE:CustomSDR;VFO:0,0,7100000;DRIVE:30;READY;');
    expect(result.dialect.id).toBe('generic-observed');
    expect(result.dialect.buildDriveSetArgs(0, 40)).toEqual([40]);
    expect(result.confidence).toBe('low');
  });
});
