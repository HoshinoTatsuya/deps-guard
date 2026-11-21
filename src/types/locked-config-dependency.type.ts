/** Config-зависимость pnpm, как её записал lock-файл (`importers['.'].configDependencies`). */
export interface LockedConfigDependency {
  readonly specifier: string;
  readonly version?: string;
  readonly line?: number;
  /** Ключ пакета (`LockedPackage.key`), который ставится по этой зависимости; нет — пакета в дереве нет. */
  readonly target?: string;
}
