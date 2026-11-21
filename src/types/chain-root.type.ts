/** Начало цепочки зависимостей: прямая зависимость проекта и пакет дерева, к которому она разрешилась. */
export interface ChainRoot {
  /** Проект (`.` — корень). */
  readonly importer: string;
  /** Поле package.json (`dependencies`, …) или `configDependencies` pnpm. */
  readonly field: string;
  /** Ключ зависимости в проекте (у алиаса — имя алиаса). */
  readonly name: string;
  /** Ключ пакета дерева (`LockedPackage.key`). */
  readonly key: string;
}
