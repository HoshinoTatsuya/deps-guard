import type { PackageSource } from './package-source.type';

/** Пакет дерева зависимостей, как его записал lock-файл. */
export interface LockedPackage {
  readonly name: string;
  readonly version: string;
  /** Ключ записи в lock-файле (для сообщения). */
  readonly key: string;
  readonly line?: number;
  readonly source: PackageSource;
  readonly integrity?: string;
  /**
   * Есть ли install-скрипт по данным САМОГО lock-файла: `true`/`false` —
   * известно, `undefined` — формат этого не хранит (pnpm lockfile v9, yarn).
   */
  readonly installScript?: boolean;
  /**
   * pnpm: пакет из `packageManagerDependencies` документа окружения (сам pnpm и
   * его зависимости). Его ставит самоустановка pnpm при переключении на
   * закреплённую версию, со своей политикой сборки: решения проекта
   * (`allowBuilds`, `permissions`) к нему не применяются, а скрипты самого
   * `pnpm` она не выполняет (замер pnpm 12.11.0 → 12.21.0).
   */
  readonly packageManager?: true;
  /** yarn 2+: условие платформы пакета (`conditions: os=darwin & cpu=arm64`). */
  readonly conditions?: string;
  /**
   * Ключи ({@link LockedPackage.key}) пакетов дерева, которые этот пакет
   * получает при установке: `dependencies`, `optionalDependencies` и
   * разрешённые peer-зависимости (pnpm и npm ставят обязательный peer сами).
   * Объявленный и не установленный peer сюда не входит: пакета в дереве нет.
   * Нет поля — зависимостей в дереве у пакета нет.
   */
  readonly dependencies?: readonly string[];
}
