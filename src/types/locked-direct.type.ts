/** Прямая зависимость проекта (importer), как её записал lock-файл. */
export interface LockedDirect {
  readonly field: 'dependencies' | 'devDependencies' | 'optionalDependencies';
  readonly specifier: string;
  readonly version?: string;
  readonly line?: number;
  /** Ключ пакета (`LockedPackage.key`), который ставится по этой зависимости; нет — пакета в дереве нет. */
  readonly target?: string;
}
