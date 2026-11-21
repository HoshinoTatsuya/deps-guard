import { posix, win32 } from 'node:path';

import type { PackageSource } from '../types/package-source.type';
import type { PackageTarget } from '../types/package-target.type';

/**
 * Единственное место, где из записи lock-файла или спецификатора package.json
 * выводится, ЧТО за пакет ставится и ОТКУДА: настоящее имя (у `npm:`-алиаса —
 * имя цели, а не ключ), диапазон и источник. Разборщики npm, pnpm и yarn и
 * правила берут это отсюда: алиас, разобранный в одном месте и не разобранный
 * в другом, — пакет, который правило судит под чужим именем.
 */
export class PackageOrigin {
  /**
   * Цель зависимости `ключ: спецификатор` (протокол — без учёта регистра, как
   * у npm: `NPM:` — тоже алиас): у `npm:имя@диапазон` — имя и
   * диапазон цели; у `jsr:` — имя пакета JSR в реестре npm (`@jsr/scope__name`);
   * иначе — ключ и спецификатор как есть.
   */
  public static target(key: string, specifier: string): PackageTarget {
    const spec = specifier.trim();
    const range = PackageOrigin.rangeOf(spec);
    if (/^npm:/i.test(spec) && PackageOrigin.isBareRange(spec.slice('npm:'.length))) {
      return { name: key, range: range ?? '', aliased: false };
    }
    if (/^npm:/i.test(spec) && range !== undefined) {
      const name = (PackageOrigin.splitNameRange(spec.slice('npm:'.length)) as { name: string }).name;
      return { name, range, aliased: name !== key };
    }
    if (/^jsr:/i.test(spec) && range !== undefined) {
      const rest = spec.slice('jsr:'.length);
      const jsrName = rest.startsWith('@')
        ? (PackageOrigin.splitNameRange(rest) as { name: string }).name
        : key;
      const scoped = /^@([^/]+)\/(.+)$/.exec(jsrName);
      if (scoped?.[1] !== undefined && scoped[2] !== undefined) {
        return { name: `@jsr/${scoped[1]}__${scoped[2]}`, range, aliased: true };
      }
    }
    return { name: key, range: spec, aliased: false };
  }

  /**
   * Диапазон цели у `npm:имя[@диапазон]` и `jsr:[@scope/имя@]диапазон`
   * (пусто — тег latest); `undefined` — спецификатор не алиас или не разобран.
   */
  public static rangeOf(specifier: string): string | undefined {
    const spec = specifier.trim();
    if (/^npm:/i.test(spec)) {
      const rest = spec.slice('npm:'.length);
      return PackageOrigin.isBareRange(rest) ? rest : PackageOrigin.splitNameRange(rest)?.range;
    }
    if (/^jsr:/i.test(spec)) {
      const rest = spec.slice('jsr:'.length);
      return rest.startsWith('@') ? PackageOrigin.splitNameRange(rest)?.range : rest;
    }
    return undefined;
  }

  /** Селектор yarn `ключ@спецификатор` → ключ и цель; `undefined` — не селектор. */
  public static ofSelector(
    selector: string,
  ): (PackageTarget & { key: string; specifier: string }) | undefined {
    const at = selector.startsWith('@')
      ? selector.indexOf('@', selector.indexOf('/') + 1)
      : selector.indexOf('@');
    if (at <= 0 || (selector.startsWith('@') && selector.indexOf('/') < 0)) {
      return undefined;
    }
    const key = selector.slice(0, at);
    const specifier = selector.slice(at + 1);
    return { key, specifier, ...PackageOrigin.target(key, specifier) };
  }

  /**
   * Источник по адресу `resolved` (npm, yarn): адреса нет — реестр по
   * умолчанию; `git+…`, `git://`, `ssh://`, `git@хост:`, `github:` и т. п. —
   * git (коммит после `#`); `file:` — локальный архив или каталог; http(s) —
   * архив по адресу. Схема — без учёта регистра. Прочее — `unknown`.
   */
  public static fromUrl(resolved: string | undefined): PackageSource {
    if (resolved === undefined || resolved === '') {
      return { kind: 'registry-default' };
    }
    if (
      /^(?:git\+|git:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:|gist:|[\w.-]+@[\w.-]+:(?!\/\/))/i.test(
        resolved,
      ) ||
      // yarn 1 считает git-адресом и http(s) с `.git` в конце пути (до `#`).
      /^https?:\/\/[^#]+\.git(?:#.*)?$/i.test(resolved)
    ) {
      const hash = resolved.indexOf('#');
      return hash >= 0
        ? { kind: 'git', url: resolved.slice(0, hash), commit: resolved.slice(hash + 1) }
        : { kind: 'git', url: resolved };
    }
    if (/^file:/i.test(resolved)) {
      return PackageOrigin.isArchive(resolved)
        ? { kind: 'file', url: resolved }
        : { kind: 'directory', url: resolved };
    }
    if (/^https?:\/\//i.test(resolved)) {
      const hash = resolved.indexOf('#');
      return { kind: 'tarball', url: hash >= 0 ? resolved.slice(0, hash) : resolved };
    }
    return { kind: 'unknown', url: resolved };
  }

  /**
   * Источник по спецификатору package.json (или yarn.lock без адреса) — так,
   * как его классифицирует npm (npm-package-arg): протокол без учёта регистра;
   * `link:` — ссылка от каталога `importer`; `npm:`/`jsr:` — реестр; `file:` и
   * путь (`./x`, `../x`, `/x`, `~/x`, `C:\x`, любой спецификатор со слэшем,
   * кроме `владелец/репозиторий`, и архив `.tgz`) — архив или каталог;
   * `git+…`, `git://`, `ssh://`, `github:` и т. п., `user@хост:путь` и
   * `владелец/репозиторий[#ref]` — git; http(s) — архив по адресу; прочая схема и
   * `workspace:`/`catalog:`/`portal:`/`patch:`/`exec:` — `unknown`; остальное —
   * диапазон, тег или версия реестра.
   */
  public static fromSpecifier(specifier: string, importer = '.'): PackageSource {
    const spec = specifier.trim();
    if (/^link:/i.test(spec)) {
      return { kind: 'link', url: PackageOrigin.linkTarget(importer, spec.slice('link:'.length)) };
    }
    if (/^(?:npm|jsr):/i.test(spec)) {
      return { kind: 'registry-default' };
    }
    if (/^(?:portal|patch|exec|workspace|catalog):/i.test(spec)) {
      return { kind: 'unknown', url: spec };
    }
    if (
      /^(?:file:|git\+|git:\/\/|ssh:\/\/|github:|gitlab:|bitbucket:|gist:|https?:\/\/)/i.test(spec) ||
      /^[^\s@/:]+@[^\s/:]+:/.test(spec)
    ) {
      return PackageOrigin.fromUrl(spec);
    }
    if (/^(?:\.|~\/|\/|\\|[a-zA-Z]:)/.test(spec)) {
      return { kind: PackageOrigin.isArchive(spec) ? 'file' : 'directory', url: `file:${spec}` };
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(spec)) {
      return { kind: 'unknown', url: spec };
    }
    const shorthand = /^([^@\s\\/#]+\/[^\s\\/#]+)(?:#(.*))?$/.exec(spec);
    if (shorthand !== null && !PackageOrigin.isArchive(shorthand[1] as string)) {
      return {
        kind: 'git',
        url: `github:${shorthand[1]}`,
        ...(shorthand[2] === undefined ? {} : { commit: shorthand[2] }),
      };
    }
    if (/[\\/]/.test(spec) || PackageOrigin.isArchive(spec)) {
      return { kind: PackageOrigin.isArchive(spec) ? 'file' : 'directory', url: `file:${spec}` };
    }
    return { kind: 'registry-default' };
  }

  /**
   * Цель ссылки `link:` от корня проекта. Абсолютный путь (POSIX, `C:\…`,
   * `\\сервер\…`) остаётся абсолютным: `posix.join('.', '/etc/x')` дал бы
   * `etc/x` — путь внутри репозитория.
   */
  public static linkTarget(importer: string, path: string): string {
    return PackageOrigin.isAbsolute(path) ? path : posix.normalize(posix.join(importer, path));
  }

  public static isAbsolute(path: string): boolean {
    return posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path);
  }

  private static isArchive(url: string): boolean {
    return /\.(?:tgz|tar\.gz|tar)$/i.test(url);
  }

  /**
   * `npm:` с диапазоном без имени (`npm:^1.0.0`, `npm:1.2.3` — так пишет yarn
   * 2+): тот же пакет под своим ключом, а не пакет с именем `^1.0.0`.
   */
  private static isBareRange(text: string): boolean {
    return !text.includes('@') && /^(?:[\^~<>=*]|v?\d|[xX](?:$|\.))/.test(text);
  }

  /** `имя@диапазон` или `@scope/имя@диапазон`; без `@диапазон` — пустой диапазон (тег latest). */
  private static splitNameRange(text: string): { name: string; range: string } | undefined {
    const at = text.startsWith('@') ? text.indexOf('@', text.indexOf('/') + 1) : text.indexOf('@');
    const name = at > 0 ? text.slice(0, at) : text;
    if (name === '' || (name.startsWith('@') && !/^@[^/]+\/[^/]+$/.test(name)) || /[\s:]/.test(name)) {
      return undefined;
    }
    return { name, range: at > 0 ? text.slice(at + 1) : '' };
  }
}
