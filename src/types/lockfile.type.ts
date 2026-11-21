import type { DanglingReference } from './dangling-reference.type';
import type { LockedCatalogEntry } from './locked-catalog-entry.type';
import type { LockedConfigDependency } from './locked-config-dependency.type';
import type { LockedDirect } from './locked-direct.type';
import type { LockedPackage } from './locked-package.type';

/** Разобранный lock-файл в общем для pnpm, npm и yarn виде. */
export interface Lockfile {
  /** `yarn` — yarn 1 (classic), `yarn-berry` — yarn 2+. */
  readonly kind: 'pnpm' | 'npm' | 'yarn' | 'yarn-berry';
  /** Путь относительно корня проекта. */
  readonly path: string;
  readonly packages: readonly LockedPackage[];
  /**
   * Прямые зависимости по проектам (`.` — корень, иначе каталог workspace).
   * `undefined` — формат не хранит прямые зависимости (yarn v1): сверка идёт
   * по ключам записей `имя@спецификатор`.
   */
  readonly importers?: Readonly<Record<string, Readonly<Record<string, LockedDirect>>>>;
  /** yarn v1 и berry: множество ключей `имя@спецификатор` (у berry — без привязки `::locator=`). */
  readonly selectors?: ReadonlySet<string>;
  /** pnpm: `overrides` lock-файла (селектор → спецификатор): подменённые спецификаторы прямых зависимостей. */
  readonly overrides?: Readonly<Record<string, string>>;
  /** pnpm `excludeLinksFromLockfile: true`: зависимости `link:` в importers не пишутся. */
  readonly linksOmitted?: boolean;
  /**
   * pnpm 9.5+: диапазоны каталогов версий, по которым решено дерево
   * (`catalogs.<каталог>.<пакет>.specifier`; каталог по умолчанию — `default`).
   * `undefined` — раздела нет (каталогами проект не пользуется).
   */
  readonly catalogs?: Readonly<Record<string, Readonly<Record<string, LockedCatalogEntry>>>>;
  /** pnpm: config-зависимости (документ окружения), имя → запись. */
  readonly configDependencies?: Readonly<Record<string, LockedConfigDependency>>;
  /**
   * yarn berry: прямые зависимости проекта записаны одним списком, без деления
   * на dependencies/devDependencies — поле при сверке не сравнивается.
   */
  readonly directFieldsMerged?: boolean;
  /**
   * yarn berry: `__metadata.version` — формат файла. По нему видно поколение
   * yarn, который ставит проект: формат 9+ пишет yarn 4.14+ (скрипты
   * зависимостей по умолчанию запрещены), а старший формат младший yarn в CI
   * не примет (`--immutable` откажет: он переписал бы версию формата).
   */
  readonly berryFormat?: number;
  /** yarn berry: `__metadata.cacheKey` — префикс, с которым checksum сверяется. */
  readonly cacheKey?: string;
  /** Прямые зависимости, которые ссылаются на пакет, которого в lock-файле нет. */
  readonly dangling?: readonly DanglingReference[];
}
