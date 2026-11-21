import type { RANGE_KINDS } from '../constants/range-kinds.constant';

/** Вид плавающего спецификатора версии. */
export type RangeKind = (typeof RANGE_KINDS)[number];
