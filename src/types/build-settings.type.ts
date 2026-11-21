import type { Lockfile } from './lockfile.type';

/** Решения менеджера пакетов о install-скриптах зависимостей — те, что эта версия менеджера читает. */
export interface BuildSettings {
  readonly manager: Lockfile['kind'];
  /** Мажорная версия pnpm из `packageManager` или `devEngines.packageManager`; `undefined` — не зафиксирована. */
  readonly pnpmMajor?: number;
  /** Версия pnpm `X.Y` (нижняя граница закрепления); `undefined` — не зафиксирована. */
  readonly pnpmVersion?: string;
  /**
   * yarn 2+: `exec:` подчиняется настройке скриптов (yarn 4.14+: исполняется,
   * только если скрипты разрешены — `enableScripts` или `built: true`); иначе
   * `exec:` исполняется при любых настройках.
   */
  readonly execGated?: boolean;
  /**
   * yarn 2+: скрипты остальных запрещены не записью `enableScripts: false`, а
   * умолчанием yarn 4.14+ (yarn.lock формата 9+) — для подсказки в находках.
   */
  readonly blockedByDefault?: boolean;
  /** Разрешённые: имя или `имя@версия` (allowBuilds: true, onlyBuiltDependencies). */
  readonly allow: ReadonlySet<string>;
  /** Явно запрещённые (allowBuilds: false, ignored-/neverBuiltDependencies). */
  readonly deny: ReadonlySet<string>;
  /**
   * Задан ли onlyBuiltDependencies: у pnpm < 10 только он запрещает остальные
   * (allowBuilds эти версии не знают).
   */
  readonly hasOnlyBuiltDependencies: boolean;
  /** dangerouslyAllowAllBuilds: true. */
  readonly allowAll: boolean;
  /** Менеджер не выполняет ни одного скрипта зависимостей (ignore-scripts / ignoreScripts). */
  readonly ignoreScripts: boolean;
  /** Файлы, из которых прочитаны решения (для пути находки). */
  readonly sources: readonly string[];
  /** Заданные ключи, которые эта версия менеджера НЕ читает: `файл: ключ` (для подсказки в находке). */
  readonly unread: readonly string[];
}
