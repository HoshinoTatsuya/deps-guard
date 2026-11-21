/** Что ставится по записи `ключ: спецификатор`: настоящее имя пакета и диапазон. */
export interface PackageTarget {
  /** Имя пакета в реестре: у `npm:`-алиаса — имя цели, а не ключ. */
  readonly name: string;
  /** Диапазон версии (у алиаса — часть после `имя@`; пусто — тег latest). */
  readonly range: string;
  /** Имя цели отличается от ключа package.json. */
  readonly aliased: boolean;
}
