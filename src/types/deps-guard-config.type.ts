import type { AllowList } from './allow-list.type';
import type { BannedPackage } from './banned-package.type';
import type { BaselineSource } from './baseline-source.type';
import type { DependencyField } from './dependency-field.type';
import type { RangeKind } from './range-kind.type';
import type { RuleId } from './rule-id.type';

/** Настройка гейта (`deps-guard.json` в корне проекта). Неизвестный ключ — отказ. */
export interface DepsGuardConfig {
  /** Lock-файл относительно корня; без ключа — единственный из pnpm-lock.yaml, package-lock.json, yarn.lock. */
  readonly lockfile?: string;
  /** Отключённые правила: правило → причина. */
  readonly disabled?: Readonly<Partial<Record<RuleId, string>>>;
  readonly newDependencies?: {
    readonly baseline?: BaselineSource;
    /** Имя зависимости → причина её появления. */
    readonly allow?: AllowList;
  };
  readonly installScripts?: {
    /** Имя пакета → почему его install-скрипту можно доверять. */
    readonly allow?: AllowList;
    /**
     * Для npm и yarn (они не умеют разрешать скрипты по списку): как в CI
     * запрещены остальные скрипты (например, `npm ci --ignore-scripts` и
     * явный `npm rebuild` разрешённых). Без ключа — «не проверено».
     */
    readonly othersBlockedBy?: string;
  };
  readonly sources?: {
    /** Разрешённые реестры (префиксы адресов). Пусто — ни один не разрешён. */
    readonly registries?: readonly string[];
    /** Реестр, из которого ставятся пакеты без адреса в lock-файле. */
    readonly defaultRegistry?: string;
    /** Имя пакета → почему ему можно не-реестровый источник (git, file, http). */
    readonly allow?: AllowList;
  };
  readonly typosquatting?: {
    /** Свой список популярных пакетов (JSON `{ "names": [...] }`) вместо встроенного. */
    readonly popularFile?: string;
    readonly allow?: AllowList;
  };
  readonly freshness?: {
    /** Порог в днях; по умолчанию 7. */
    readonly minAgeDays?: number;
    /** Кэш метаданных реестра в репозитории (`deps-guard metadata`). */
    readonly metadataFile?: string;
    /** `имя@версия` → причина взять свежую версию. */
    readonly allow?: AllowList;
  };
  readonly floatingRanges?: {
    /** Запрещённые виды; по умолчанию — все. */
    readonly forbid?: readonly RangeKind[];
    /** Проверяемые поля; по умолчанию — все три. */
    readonly fields?: readonly DependencyField[];
    readonly allow?: AllowList;
  };
  /**
   * Пакеты, которых не должно быть в установленном дереве (прямо, транзитивно,
   * peer, optional, под алиасом). Нет ключа или пустой перечень — правило
   * ничего не запрещает: это перечень проекта, а не контроль доступа.
   */
  readonly bannedPackages?: readonly BannedPackage[];
}
