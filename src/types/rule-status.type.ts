/**
 * Итог правила: `passed` — проверено и чисто; `failed` — нарушения или
 * устаревшие допуски; `unverified` — часть не проверена; `broken` — вход не
 * прочитан; `disabled` — правило отключено настройкой с причиной.
 */
export type RuleStatus = 'passed' | 'failed' | 'unverified' | 'broken' | 'disabled';
