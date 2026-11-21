/** Запись каталога версий pnpm, как её записал lock-файл (`catalogs.<имя>.<пакет>`). */
export interface LockedCatalogEntry {
  readonly specifier: string;
  readonly line?: number;
}
