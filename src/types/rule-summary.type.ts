import type { RuleId } from './rule-id.type';
import type { RuleStatus } from './rule-status.type';

/** Итог одного правила в отчёте. */
export interface RuleSummary {
  readonly rule: RuleId;
  readonly title: string;
  readonly status: RuleStatus;
  /** Сколько предметов правило рассмотрело (выборка не выродилась — видно по числу). */
  readonly checked: number;
  /** Для `disabled` — причина из настройки. */
  readonly disabledReason?: string;
}
