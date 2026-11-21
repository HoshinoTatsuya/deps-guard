import { DEPENDENCY_FIELDS } from '../constants/dependency-fields.constant';
import { InputUnreadableError } from '../input-unreadable.error';
import { WorkspaceDirs } from '../project/workspace-dirs';
import type { DanglingReference } from '../types/dangling-reference.type';
import type { LockedDirect } from '../types/locked-direct.type';
import type { LockedPackage } from '../types/locked-package.type';
import type { Lockfile } from '../types/lockfile.type';
import { valueText } from '../value-text';
import { PackageOrigin } from './package-origin';

/**
 * package-lock.json (и npm-shrinkwrap.json) версий 2 и 3: раздел `packages`.
 * Версия 1 (npm 6) — отказ: в ней нет плоского списка и признака скриптов.
 * npm записывает `hasInstallScript` у каждого пакета со скриптом, поэтому его
 * отсутствие здесь означает «скрипта нет», а не «неизвестно».
 *
 * Пакеты из `bundleDependencies` (`inBundle: true`) приезжают внутри архива
 * родителя, но npm выполняет их install-скрипты: они в дереве, с источником
 * `bundled` (адрес и integrity — у родителя).
 */
export class ParseNpmLock {
  public static parse(text: string, path: string): Lockfile {
    let root: unknown;
    try {
      root = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new InputUnreadableError(path, `не JSON: ${(error as Error).message}`);
    }
    const lock = root as { lockfileVersion?: unknown; packages?: unknown };
    if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
      throw new InputUnreadableError(
        path,
        `lockfileVersion ${valueText(lock.lockfileVersion)} не поддерживается (поддержаны 2 и 3, npm 7+)`,
      );
    }
    if (typeof lock.packages !== 'object' || lock.packages === null || Array.isArray(lock.packages)) {
      throw new InputUnreadableError(path, 'нет раздела packages');
    }
    const lines = ParseNpmLock.keyLines(text);
    const entries = lock.packages as Record<string, unknown>;
    // Проекты workspace — каталоги под шаблонами `workspaces` корневой записи
    // (npm 7+ переносит их туда из package.json). Прочие записи вне
    // node_modules — цели `file:`/`link:`-ссылок (`vendor/lib`, `../shared`):
    // пакет уже представлен записью-ссылкой, а проектом репозитория он не
    // является — его package.json не читается как проект.
    const rootEntry = entries[''];
    const patterns = WorkspaceDirs.patterns(
      'npm',
      typeof rootEntry === 'object' && rootEntry !== null ? (rootEntry as Record<string, unknown>) : {},
      {},
      { manifest: path, workspace: path },
    );
    const packages: LockedPackage[] = [];
    const importers: Record<string, Record<string, LockedDirect>> = Object.create(null);
    for (const [key, raw] of Object.entries(entries)) {
      if (typeof raw !== 'object' || raw === null) {
        throw new InputUnreadableError(path, `запись «${key}»: ожидался объект`, lines.get(key));
      }
      const entry = raw as Record<string, unknown>;
      const line = lines.get(key);
      const at = key.lastIndexOf('node_modules/');
      if (at < 0) {
        if (key === '' || WorkspaceDirs.match('npm', patterns, [key]).length > 0) {
          importers[key === '' ? '.' : key] = ParseNpmLock.directsOf(entry, line);
        }
        continue;
      }
      const name = typeof entry.name === 'string' ? entry.name : key.slice(at + 'node_modules/'.length);
      const resolved = typeof entry.resolved === 'string' ? entry.resolved : undefined;
      if (entry.link === true) {
        packages.push({
          name,
          version: `link:${resolved ?? ''}`,
          key,
          ...(line === undefined ? {} : { line }),
          source: { kind: 'link', url: resolved ?? '' },
        });
        continue;
      }
      if (typeof entry.version !== 'string') {
        throw new InputUnreadableError(path, `запись «${key}»: нет version`, line);
      }
      packages.push({
        name,
        version: entry.version,
        key,
        ...(line === undefined ? {} : { line }),
        source:
          entry.inBundle === true
            ? { kind: 'bundled', url: key.slice(0, at).replace(/\/$/, '') }
            : PackageOrigin.fromUrl(resolved),
        ...(typeof entry.integrity === 'string' ? { integrity: entry.integrity } : {}),
        installScript: entry.hasInstallScript === true,
      });
    }
    return {
      kind: 'npm',
      path,
      packages: ParseNpmLock.link(packages, importers, entries),
      importers,
      dangling: ParseNpmLock.dangling(importers, entries),
    };
  }

  /**
   * Рёбра дерева по правилу поиска node: зависимость записи `a/node_modules/b`
   * ищется в `a/node_modules/b/node_modules/<имя>`, затем выше по каталогам до
   * корня. Зависимости пакета — `dependencies`, `optionalDependencies` и
   * `peerDependencies`, если peer в дереве есть (npm 7+ ставит обязательный
   * peer сам); не найденный (объявленный и не установленный) — не ребро.
   * Ссылка (`link: true`) ведёт к зависимостям своей цели. Прямые зависимости
   * проектов получают `target` — ключ записи, к которой разрешились.
   */
  private static link(
    packages: LockedPackage[],
    importers: Record<string, Record<string, LockedDirect>>,
    entries: Readonly<Record<string, unknown>>,
  ): LockedPackage[] {
    const resolveFrom = (location: string, name: string): string | undefined => {
      let dir = location;
      for (;;) {
        const candidate = `${dir === '' ? '' : `${dir}/`}node_modules/${name}`;
        if (Object.hasOwn(entries, candidate)) {
          return candidate;
        }
        if (dir === '') {
          return undefined;
        }
        const at = dir.lastIndexOf('/node_modules/');
        dir = at >= 0 ? dir.slice(0, at) : dir.startsWith('node_modules/') ? '' : ParseNpmLock.parentDir(dir);
      }
    };
    const depsOf = (location: string): string[] => {
      const entry = entries[location];
      if (typeof entry !== 'object' || entry === null) {
        return [];
      }
      const found = new Set<string>();
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const deps = (entry as Record<string, unknown>)[field];
        if (typeof deps !== 'object' || deps === null) {
          continue;
        }
        for (const name of Object.keys(deps)) {
          const target = resolveFrom(location, name);
          if (target !== undefined) {
            found.add(target);
          }
        }
      }
      return [...found];
    };
    for (const [importer, directs] of Object.entries(importers)) {
      const location = importer === '.' ? '' : importer;
      for (const [name, direct] of Object.entries(directs)) {
        const target = resolveFrom(location, name);
        if (target !== undefined) {
          directs[name] = { ...direct, target };
        }
      }
    }
    return packages.map((pkg) => {
      const location =
        pkg.source.kind === 'link' && pkg.source.url !== undefined && Object.hasOwn(entries, pkg.source.url)
          ? pkg.source.url
          : pkg.key;
      const deps = depsOf(location).filter((key) => key !== pkg.key);
      return deps.length === 0 ? pkg : { ...pkg, dependencies: deps };
    });
  }

  /** Родительский каталог пути вне node_modules (`packages/a` → `packages`, `a` → корень). */
  private static parentDir(dir: string): string {
    const at = dir.lastIndexOf('/');
    return at >= 0 ? dir.slice(0, at) : '';
  }

  /**
   * Прямая зависимость проекта, у которой нет записи `node_modules/<имя>` ни
   * в каталоге проекта, ни в корне: npm её не поставит, а правила её не видят.
   */
  private static dangling(
    importers: Readonly<Record<string, Readonly<Record<string, LockedDirect>>>>,
    entries: Readonly<Record<string, unknown>>,
  ): DanglingReference[] {
    const dangling: DanglingReference[] = [];
    for (const [importer, directs] of Object.entries(importers)) {
      const own = importer === '.' ? '' : `${importer}/`;
      for (const [name, direct] of Object.entries(directs)) {
        if (
          !Object.hasOwn(entries, `${own}node_modules/${name}`) &&
          !Object.hasOwn(entries, `node_modules/${name}`)
        ) {
          dangling.push({
            importer,
            name,
            version: direct.specifier,
            ...(direct.line === undefined ? {} : { line: direct.line }),
          });
        }
      }
    }
    return dangling;
  }

  private static directsOf(
    entry: Record<string, unknown>,
    line: number | undefined,
  ): Record<string, LockedDirect> {
    const directs: Record<string, LockedDirect> = Object.create(null);
    for (const field of DEPENDENCY_FIELDS) {
      const deps = entry[field];
      if (typeof deps !== 'object' || deps === null) {
        continue;
      }
      for (const [name, specifier] of Object.entries(deps as Record<string, unknown>)) {
        if (typeof specifier === 'string') {
          directs[name] = { field, specifier, ...(line === undefined ? {} : { line }) };
        }
      }
    }
    return directs;
  }

  /** Строка ключа записи раздела packages (npm пишет их с отступом 4). */
  private static keyLines(text: string): Map<string, number> {
    const lines = new Map<string, number>();
    text.split(/\r?\n/).forEach((line, index) => {
      const match = /^ {4}"((?:[^"\\]|\\.)*)": \{/.exec(line);
      if (match?.[1] !== undefined && !lines.has(match[1])) {
        lines.set(JSON.parse(`"${match[1]}"`) as string, index + 1);
      }
    });
    return lines;
  }
}
