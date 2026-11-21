import type { LockedPackage } from './locked-package.type';

/** Параметры выгрузки метаданных реестра в кэш. */
export interface FetchMetadataOptions {
  /** Адрес реестра по умолчанию (`https://registry.npmjs.org/`). */
  readonly registry: string;
  /**
   * Реестры scope (`@scope` → адрес), как в `@scope:registry` `.npmrc`: пакет
   * scope берётся оттуда, а не у одноимённого пакета реестра по умолчанию.
   */
  readonly scopeRegistries?: Readonly<Record<string, string>>;
  readonly packages: readonly LockedPackage[];
  /** Потолок одного запроса; по умолчанию 15 с. */
  readonly timeoutMs?: number;
  /**
   * Заголовок Authorization (например, `Bearer <токен>`) — только для реестра
   * по умолчанию: реестрам scope и хостам архивов он не отправляется.
   */
  readonly authorization?: string;
  /** Одновременных запросов; по умолчанию 8. */
  readonly concurrency?: number;
}
