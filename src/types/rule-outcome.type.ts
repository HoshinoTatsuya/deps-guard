import type { Finding } from './finding.type';

/** Результат правила: находки и размер рассмотренной выборки. */
export interface RuleOutcome {
  readonly findings: readonly Finding[];
  readonly checked: number;
}
