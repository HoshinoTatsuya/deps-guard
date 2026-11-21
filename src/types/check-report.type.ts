import type { Finding } from './finding.type';
import type { RuleSummary } from './rule-summary.type';

/** Отчёт проверки: находки и итог каждого правила. */
export interface CheckReport {
  readonly tool: { readonly name: string; readonly version: string };
  readonly root: string;
  readonly lockfile?: string;
  /** Опорное время проверки (ISO): от него считается возраст версий. */
  readonly now?: string;
  /** Предупреждения отчёта (код выхода не меняют). */
  readonly warnings?: readonly string[];
  readonly rules: readonly RuleSummary[];
  readonly findings: readonly Finding[];
}
