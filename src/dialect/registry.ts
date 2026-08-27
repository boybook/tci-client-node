import { TciError } from '../errors.js';
import { builtInDialects } from './builtins.js';
import type {
  TciDialect,
  TciDialectDetection,
  TciDialectDetectionContext,
  TciDialectId,
  TciDialectSelection,
} from './types.js';

export class TciDialectRegistry {
  private readonly dialects = new Map<TciDialectId, TciDialect>();

  constructor(dialects: readonly TciDialect[] = builtInDialects) {
    for (const dialect of dialects) this.register(dialect);
  }

  register(dialect: TciDialect): void { this.dialects.set(dialect.id, dialect); }
  get(id: TciDialectId): TciDialect | undefined { return this.dialects.get(id); }
  list(): TciDialect[] { return [...this.dialects.values()]; }

  select(context: TciDialectDetectionContext, selection: TciDialectSelection = 'auto'): TciDialectDetection {
    if (typeof selection === 'object') {
      return { dialect: selection, confidence: 'manual', evidence: ['Custom dialect supplied by caller'], warnings: [] };
    }
    if (selection !== 'auto') {
      const dialect = this.get(selection);
      if (!dialect) throw new TciError('unknown-dialect', `Unknown TCI dialect: ${selection}`);
      return { dialect: dialect.resolve?.(context) ?? dialect, confidence: 'manual', evidence: [`Dialect ${selection} selected by caller`], warnings: [] };
    }

    const candidates = this.list()
      .map((dialect) => ({ dialect, result: dialect.detect(context) }))
      .sort((left, right) => right.result.score - left.result.score);
    const selected = candidates[0];
    if (!selected || selected.result.score <= 0) {
      throw new TciError('unknown-dialect', 'Unable to identify the TCI server dialect');
    }
    return {
      dialect: selected.dialect.resolve?.(context) ?? selected.dialect,
      confidence: selected.result.score >= 100 ? 'high' : selected.result.score >= 70 ? 'medium' : 'low',
      evidence: selected.result.evidence,
      warnings: selected.result.warnings ?? [],
    };
  }
}

export const defaultTciDialectRegistry = new TciDialectRegistry();
