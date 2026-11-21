import type { RuleContext } from './rule-context.type';
import type { RuleId } from './rule-id.type';
import type { RuleOutcome } from './rule-outcome.type';

/** Правило гейта. */
export interface Rule {
  readonly id: Exclude<RuleId, 'input'>;
  run(context: RuleContext): RuleOutcome;
}
