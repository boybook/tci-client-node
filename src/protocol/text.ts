export interface TciCommand {
  /** Lower-case command name for case-insensitive matching. */
  name: string;
  /** Original command name as received, without surrounding whitespace. */
  originalName: string;
  /** Unescaped argument list. Empty commands have an empty array. */
  args: string[];
  /** Raw command fragment without the trailing semicolon. */
  raw: string;
}

export type TciCommandInput = string | TciCommand;

const ESCAPE_TO_CHAR: Record<string, string> = {
  '^': ':',
  '~': ',',
  '*': ';',
};

const CHAR_TO_ESCAPE: Record<string, string> = {
  ':': '^',
  ',': '~',
  ';': '*',
};

export function escapeTciText(value: unknown): string {
  return String(value).replace(/[:;,]/g, (char) => CHAR_TO_ESCAPE[char] ?? char);
}

export function unescapeTciText(value: string): string {
  return value.replace(/[\^~*]/g, (char) => ESCAPE_TO_CHAR[char] ?? char);
}

export function parseTciText(text: string | Buffer | ArrayBuffer | ArrayBufferView): TciCommand[] {
  const source = normalizeTextInput(text);
  const commands: TciCommand[] = [];

  for (const fragment of source.split(';')) {
    const raw = fragment.trim();
    if (!raw) {
      continue;
    }

    const colonIndex = raw.indexOf(':');
    const originalName = (colonIndex >= 0 ? raw.slice(0, colonIndex) : raw).trim();
    if (!originalName) {
      continue;
    }

    const argsText = colonIndex >= 0 ? raw.slice(colonIndex + 1) : undefined;
    commands.push({
      name: originalName.toLowerCase(),
      originalName,
      args: argsText === undefined ? [] : splitArgs(argsText),
      raw,
    });
  }

  return commands;
}

export function parseTciCommand(input: TciCommandInput): TciCommand {
  if (typeof input !== 'string') {
    return input;
  }
  const [command] = parseTciText(input);
  if (!command) {
    throw new Error(`Invalid TCI command: ${input}`);
  }
  return command;
}

export function formatTciCommand(name: string, args: readonly unknown[] = []): string {
  const commandName = name.trim().toUpperCase();
  if (!commandName) {
    throw new Error('TCI command name cannot be empty');
  }
  if (args.length === 0) {
    return `${commandName};`;
  }
  return `${commandName}:${args.map(escapeTciText).join(',')};`;
}

export function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

export function isCommandReplyTo(replyInput: TciCommandInput, requestInput: TciCommandInput): boolean {
  const reply = parseTciCommand(replyInput);
  const request = parseTciCommand(requestInput);
  if (reply.name !== request.name) {
    return false;
  }

  if (request.args.length === 0) {
    return true;
  }

  if (argsHavePrefix(reply.args, request.args)) {
    return true;
  }

  return isKnownVariantReply(reply, request);
}

export function commandKey(command: TciCommandInput): string {
  const parsed = parseTciCommand(command);
  return `${parsed.name}:${parsed.args.join(',')}`;
}

function normalizeTextInput(text: string | Buffer | ArrayBuffer | ArrayBufferView): string {
  if (typeof text === 'string') {
    return text;
  }
  if (Buffer.isBuffer(text)) {
    return text.toString('utf8');
  }
  if (text instanceof ArrayBuffer) {
    return Buffer.from(text).toString('utf8');
  }
  return Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString('utf8');
}

function splitArgs(argsText: string): string[] {
  return argsText.split(',').map((arg) => unescapeTciText(arg.trim()));
}

function argsHavePrefix(args: readonly string[], prefix: readonly string[]): boolean {
  if (args.length < prefix.length) {
    return false;
  }
  return prefix.every((arg, index) => args[index]?.toLowerCase() === arg.toLowerCase());
}

function isKnownVariantReply(reply: TciCommand, request: TciCommand): boolean {
  if (reply.name === 'modulation') {
    // ExpertSDR/WSJT-X variants can use MODULATION:rx,mode and MODULATION:rx,vfo,mode.
    if (request.args.length === 2 && reply.args.length >= 3) {
      return reply.args[0] === request.args[0] && reply.args[2]?.toLowerCase() === request.args[1]?.toLowerCase();
    }
    if (request.args.length === 3 && reply.args.length === 2) {
      return reply.args[0] === request.args[0] && reply.args[1]?.toLowerCase() === request.args[2]?.toLowerCase();
    }
  }

  if (reply.name === 'protocol') {
    return request.args.length <= 1;
  }

  if (reply.name === 'trx' && request.args.length >= 3 && reply.args.length >= 2) {
    // Official TRX writes may include an audio source as arg3, while replies only echo trx+state.
    return reply.args[0] === request.args[0] && reply.args[1]?.toLowerCase() === request.args[1]?.toLowerCase();
  }

  return false;
}
