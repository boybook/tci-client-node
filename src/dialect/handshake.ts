import { TciError } from '../errors.js';
import type { TciCommand } from '../protocol/text.js';
import type { TciProtocolIdentity } from './types.js';

const IDENTITY_COMMANDS = new Set(['protocol', 'device', 'trx_count', 'channels_count', 'channel_count']);
const STATE_COMMANDS = new Set(['vfo', 'modulation', 'modulations_list', 'trx', 'drive']);

export function parseProtocolIdentity(commands: readonly TciCommand[]): TciProtocolIdentity {
  const protocol = [...commands].reverse().find((command) => command.name === 'protocol');
  const device = [...commands].reverse().find((command) => command.name === 'device');
  const rawProtocolArgs = protocol?.args ?? [];
  const firstLooksLikeVersion = /^\d+(?:\.\d+){0,2}/.test(rawProtocolArgs[0] ?? '');
  return {
    programName: firstLooksLikeVersion ? undefined : rawProtocolArgs[0],
    protocolVersion: firstLooksLikeVersion ? rawProtocolArgs[0] : rawProtocolArgs[1],
    rawProtocolArgs: [...rawProtocolArgs],
    device: device?.args.join(','),
  };
}

export function assertValidTciHandshake(commands: readonly TciCommand[]): void {
  const names = new Set(commands.map((command) => command.name));
  if (!names.has('ready')) throw new TciError('handshake-timeout', 'TCI READY was not received');
  const categories = [
    [...IDENTITY_COMMANDS].some((name) => names.has(name)),
    [...STATE_COMMANDS].some((name) => names.has(name)),
  ].filter(Boolean).length;
  const identitySignals = [...IDENTITY_COMMANDS].filter((name) => names.has(name)).length;
  if (categories < 2 && identitySignals < 2) {
    throw new TciError('invalid-handshake', 'WebSocket opened but did not provide enough TCI initialization evidence');
  }
}
