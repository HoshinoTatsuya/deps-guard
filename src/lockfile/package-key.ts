/**
 * Имя и версия из ключа записи lock-файла: `имя@версия`, `@scope/имя@версия`,
 * у pnpm lockfile v6 — с ведущим `/` и суффиксом peer-зависимостей `(…)`.
 * Версия может быть адресом (`имя@https://…`, `имя@file:…`): разделитель —
 * первый `@` после имени, а имя `@` внутри не содержит.
 */
export class PackageKey {
  public static split(key: string): { name: string; version: string } | undefined {
    const bare = key.startsWith('/') ? key.slice(1) : key;
    const nameEnd = bare.startsWith('@') ? bare.indexOf('@', bare.indexOf('/') + 1) : bare.indexOf('@');
    if (nameEnd <= 0 || (bare.startsWith('@') && bare.indexOf('/') < 0)) {
      return undefined;
    }
    const name = bare.slice(0, nameEnd);
    const rawVersion = bare.slice(nameEnd + 1);
    const peers = /^[^(]*?(?=\()/.exec(rawVersion);
    const version = peers ? peers[0] : rawVersion;
    return version === '' ? undefined : { name, version };
  }
}
