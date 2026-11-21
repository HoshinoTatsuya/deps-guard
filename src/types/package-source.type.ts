/**
 * Откуда менеджер пакетов берёт пакет:
 * - `registry-default` — реестр установки (в lock-файле нет адреса);
 * - `tarball` — архив по адресу http(s);
 * - `git`, `file` (локальный архив), `directory`, `link` — не из реестра;
 * - `bundled` — внутри архива другого пакета (npm `bundleDependencies`):
 *   своего адреса и integrity нет, их покрывает integrity родителя;
 * - `unknown` — форма записи не распознана (это нарушение, а не пропуск).
 */
export interface PackageSource {
  readonly kind:
    | 'registry-default'
    | 'tarball'
    | 'git'
    | 'file'
    | 'directory'
    | 'link'
    | 'bundled'
    | 'unknown';
  readonly url?: string;
  /** Для git: закреплённый коммит. */
  readonly commit?: string;
}
