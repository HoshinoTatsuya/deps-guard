import { deepFreeze } from '../deep-freeze';

/**
 * Коды выхода CLI: `findings` — нарушения или устаревшие допуски; `unverified`
 * — нарушений нет, но часть не проверена или вход не прочитан. «Не проверено»
 * отличается и от успеха, и от нарушения.
 */
export const EXIT_CODE = { clean: 0, findings: 1, unverified: 2 } as const;

deepFreeze(EXIT_CODE);
