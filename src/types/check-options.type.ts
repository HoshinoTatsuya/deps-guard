import type { DepsGuardConfig } from './deps-guard-config.type';
import type { PackageMetadata } from './package-metadata.type';

/** Параметры проверки. */
export interface CheckOptions {
  /** Корень проекта (каталог package.json и lock-файла). */
  readonly root: string;
  /** Настройка; без неё читается `deps-guard.json` корня. */
  readonly config?: DepsGuardConfig;
  /** Базовая git-ревизия для новых зависимостей (перекрывает настройку). */
  readonly baseRef?: string;
  /** Метаданные реестра от вызывающего; дополняют и перекрывают кэш из настройки. */
  readonly metadata?: Readonly<Record<string, PackageMetadata>>;
  /** «Сейчас» для порога свежести; по умолчанию — текущее время. */
  readonly now?: Date;
  /**
   * Окружение, в котором запущен гейт (по умолчанию — окружение процесса): по
   * нему печатается предупреждение о переменных `YARN_*`, которые yarn берёт
   * поверх `.yarnrc.yml`. Значения не читаются и не выводятся — только имена.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}
