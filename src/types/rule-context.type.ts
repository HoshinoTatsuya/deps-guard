import type { DepsGuardConfig } from './deps-guard-config.type';
import type { Lockfile } from './lockfile.type';
import type { Manifest } from './manifest.type';
import type { PackageMetadata } from './package-metadata.type';
import type { VersionCatalogs } from './version-catalogs.type';
import type { YamlDocument } from './yaml-document.type';

/** Всё, что правило знает о проекте. Правила не читают диск сами, кроме ленивых источников. */
export interface RuleContext {
  readonly root: string;
  readonly config: DepsGuardConfig;
  /** Путь настройки для находок о ней. */
  readonly configPath: string;
  readonly lock: Lockfile;
  readonly manifests: readonly Manifest[];
  /** pnpm-workspace.yaml корня (только у pnpm); `undefined` — файла нет. */
  readonly pnpmWorkspace?: YamlDocument;
  /** Каталоги версий (`catalog:`): pnpm — pnpm-workspace.yaml, yarn 4.10+ — `.yarnrc.yml`; нет — из pnpmWorkspace. */
  readonly catalogs?: VersionCatalogs;
  /** Метаданные реестра: имя → документ (кэш в репозитории и/или переданные вызывающим). */
  readonly metadata: ReadonlyMap<string, PackageMetadata>;
  /** Базовая git-ревизия из вызова (перекрывает настройку). */
  readonly baseRef?: string;
  readonly now: Date;
  /** Популярные имена для проверки похожих. */
  readonly popular: () => readonly string[];
  /** Чтение файла базовой ревизии: `undefined` — файла в ревизии нет. */
  readonly gitShow: (ref: string, path: string) => string | undefined;
  /** Файлы базовой ревизии под корнем проекта (пути от корня). */
  readonly gitList: (ref: string) => string[];
}
