import { deepFreeze } from '../deep-freeze';

/**
 * Виды плавающих спецификаторов: `caret` (`^1.2.3`), `tilde` (`~1.2.3`),
 * `x-range` (`1.x`, `1.2.*`, `1`), `any` (`*`, `x`, пусто), `tag` (`latest`,
 * `next`), `comparator` (`>=1`, `<2`, `1 - 2`, `^1 || ^2`).
 */
export const RANGE_KINDS = ['caret', 'tilde', 'x-range', 'any', 'tag', 'comparator'] as const;

deepFreeze(RANGE_KINDS);
