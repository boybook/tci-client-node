import { describe, expect, it } from 'vitest';
import { escapeTciText, formatTciCommand, isCommandReplyTo, parseTciText, unescapeTciText } from '../src/protocol/index.js';

it('parses multiple semicolon-delimited commands case-insensitively', () => {
  const commands = parseTciText('PROTOCOL:2.0; vfo:0,0,14074000;READY:true;;');
  expect(commands).toMatchObject([
    { name: 'protocol', args: ['2.0'] },
    { name: 'vfo', args: ['0', '0', '14074000'] },
    { name: 'ready', args: ['true'] },
  ]);
});

it('preserves empty arguments and unescapes reserved command characters', () => {
  const escaped = escapeTciText('CQ:TEST,599;BK');
  expect(escaped).toBe('CQ^TEST~599*BK');
  expect(unescapeTciText(escaped)).toBe('CQ:TEST,599;BK');
  expect(parseTciText(`CW_MSG:${escaped},;`)[0]?.args).toEqual(['CQ:TEST,599;BK', '']);
});

it('formats commands with escaped args', () => {
  expect(formatTciCommand('cw_msg', ['CQ:TEST,599;BK'])).toBe('CW_MSG:CQ^TEST~599*BK;');
  expect(formatTciCommand('READY')).toBe('READY;');
});

it('matches reads, writes, and modulation two/three argument variants', () => {
  expect(isCommandReplyTo('VFO:0,0,14074000;', 'VFO:0,0;')).toBe(true);
  expect(isCommandReplyTo('VFO:0,0,14074000;', 'VFO:0,0,14074000;')).toBe(true);
  expect(isCommandReplyTo('VFO:0,0,7100000;', 'VFO:0,0,14074000;')).toBe(false);
  expect(isCommandReplyTo('MODULATION:0,0,DIGU;', 'MODULATION:0,DIGU;')).toBe(true);
  expect(isCommandReplyTo('MODULATION:0,DIGU;', 'MODULATION:0,0,DIGU;')).toBe(true);
  expect(isCommandReplyTo('TRX:0,true;', 'TRX:0,true,tci;')).toBe(true);
  expect(isCommandReplyTo('TRX:0,false;', 'TRX:0,true,tci;')).toBe(false);
});
