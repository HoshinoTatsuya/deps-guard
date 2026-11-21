import type { ChainRoot } from './chain-root.type';

/** Путь от прямой зависимости проекта до пакета дерева: ключи пакетов по порядку, последний — искомый. */
export interface DependencyChain {
  readonly root: ChainRoot;
  readonly keys: readonly string[];
}
