export type TciErrorCode =
  | 'connect-timeout'
  | 'command-timeout'
  | 'not-connected'
  | 'disconnected'
  | 'protocol-error'
  | 'invalid-frame'
  | 'cancelled';

export class TciError extends Error {
  readonly code: TciErrorCode;
  readonly details?: unknown;

  constructor(code: TciErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'TciError';
    this.code = code;
    this.details = details;
  }
}

export function toTciError(error: unknown, fallbackCode: TciErrorCode = 'protocol-error'): TciError {
  if (error instanceof TciError) {
    return error;
  }
  if (error instanceof Error) {
    return new TciError(fallbackCode, error.message, error);
  }
  return new TciError(fallbackCode, String(error), error);
}
