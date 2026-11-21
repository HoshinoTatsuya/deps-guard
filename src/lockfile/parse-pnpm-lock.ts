import { DEPENDENCY_FIELDS } from '../constants/dependency-fields.constant';
import { InputUnreadableError } from '../input-unreadable.error';
import type { DanglingReference } from '../types/dangling-reference.type';
import type { LockedCatalogEntry } from '../types/locked-catalog-entry.type';
import type { LockedConfigDependency } from '../types/locked-config-dependency.type';
import type { LockedDirect } from '../types/locked-direct.type';
import type { LockedPackage } from '../types/locked-package.type';
import type { Lockfile } from '../types/lockfile.type';
import type { PackageSource } from '../types/package-source.type';
import type { YamlDocument } from '../types/yaml-document.type';
import type { YamlObject } from '../types/yaml-object.type';
import type { YamlValue } from '../types/yaml-value.type';
import { valueText } from '../value-text';
import { YamlSubset } from '../yaml/yaml-subset';
import { YamlSubsetError } from '../yaml/yaml-subset.error';
import { PackageKey } from './package-key';
import { PackageOrigin } from './package-origin';

/**
 * pnpm-lock.yaml версий 6.x и 9.x, включая несколько документов (pnpm 11+
 * пишет первым документ окружения: сам pnpm и config-зависимости — они тоже
 * ставятся и проверяются). Прочие версии — отказ, а не попытка угадать.
 *
 * lockfile v9 не хранит признак install-скрипта (`requiresBuild` был в v6):
 * у v9 он `undefined` и берётся из метаданных реестра.
 *
 * Кроме пакетов и прямых зависимостей, читается то, без чего сверка с
 * package.json ложно краснеет или ложно зеленеет: `overrides` (pnpm пишет в
 * importers спецификатор подмены), `settings.excludeLinksFromLockfile`
 * (ссылки `link:` в importers не пишутся), config-зависимости и прямые
 * зависимости, указывающие на пакет, которого в файле нет.
 */
export class ParsePnpmLock {
  public static parse(text: string, path: string): Lockfile {
    let documents: YamlDocument[];
    try {
      documents = YamlSubset.parseAll(text);
    } catch (error) {
      if (error instanceof YamlSubsetError) {
        throw new InputUnreadableError(path, error.detail, error.line);
      }
      throw error;
    }
    const locks = documents.filter((document) => ParsePnpmLock.isObject(document.value));
    if (locks.length === 0 || locks.length !== documents.length) {
      throw new InputUnreadableError(path, 'ожидались документы-отображения с lockfileVersion');
    }
    const packages: LockedPackage[] = [];
    const known = new Set<string>();
    const importers: Record<string, Record<string, LockedDirect>> = Object.create(null);
    const overrides: Record<string, string> = Object.create(null);
    const configDependencies: Record<string, LockedConfigDependency> = Object.create(null);
    let catalogs: Record<string, Record<string, LockedCatalogEntry>> | undefined;
    let linksOmitted = false;
    const edges: Array<{ from: string; children: Array<[string, string]> }> = [];
    for (const document of locks) {
      const root = document.value as YamlObject;
      const version = typeof root.lockfileVersion === 'string' ? root.lockfileVersion : undefined;
      if (version === undefined || !/^(?:6|9)\.\d+$/.test(version)) {
        throw new InputUnreadableError(
          path,
          `lockfileVersion «${valueText(root.lockfileVersion)}» не поддерживается (поддержаны 6.x и 9.x)`,
          document.lineOf(root, 'lockfileVersion'),
        );
      }
      const v6 = version.startsWith('6.');
      edges.push(...ParsePnpmLock.edgesOf(document, root, v6, path));
      const manager = ParsePnpmLock.packageManagerOnly(root);
      for (const parsed of ParsePnpmLock.packagesOf(document, root, v6, path)) {
        const pkg: LockedPackage = manager.has(ParsePnpmLock.bare(parsed.key))
          ? { ...parsed, packageManager: true }
          : parsed;
        packages.push(pkg);
        known.add(`${pkg.name}@${pkg.version}`);
        known.add(ParsePnpmLock.bare(pkg.key));
      }
      for (const [importer, directs] of ParsePnpmLock.importersOf(document, root, path)) {
        importers[importer] = Object.assign(Object.create(null), importers[importer], directs);
      }
      Object.assign(overrides, ParsePnpmLock.stringsOf(document, root, 'overrides', path));
      Object.assign(configDependencies, ParsePnpmLock.configDependenciesOf(document, root, path));
      const own = ParsePnpmLock.catalogsOf(document, root, path);
      if (own !== undefined) {
        catalogs = Object.assign(catalogs ?? Object.create(null), own);
      }
      const settings = ParsePnpmLock.isObject(root.settings ?? null) ? (root.settings as YamlObject) : {};
      linksOmitted ||= ParsePnpmLock.flag(document, settings, 'excludeLinksFromLockfile', path) === true;
    }
    const graph = ParsePnpmLock.graph(packages, edges);
    for (const directs of Object.values(importers)) {
      for (const [name, direct] of Object.entries(directs)) {
        const target = direct.version === undefined ? undefined : graph.resolve(name, direct.version)[0];
        if (target !== undefined) {
          directs[name] = { ...direct, target };
        }
      }
    }
    for (const [name, config] of Object.entries(configDependencies)) {
      const target = config.version === undefined ? undefined : graph.resolve(name, config.version)[0];
      if (target !== undefined) {
        configDependencies[name] = { ...config, target };
      }
    }
    const dangling: DanglingReference[] = [];
    for (const [importer, directs] of Object.entries(importers)) {
      for (const [name, direct] of Object.entries(directs)) {
        const version = direct.version;
        if (version === undefined) {
          continue;
        }
        if (/^link:/i.test(version)) {
          packages.push({
            name,
            version,
            key: `${importer} → ${name}`,
            ...(direct.line === undefined ? {} : { line: direct.line }),
            // Адрес ссылки — от каталога проекта; в находке и проверке — от корня.
            source: { kind: 'link', url: PackageOrigin.linkTarget(importer, version.slice('link:'.length)) },
          });
          continue;
        }
        const bare = ParsePnpmLock.bare(version);
        if (!known.has(`${name}@${bare}`) && !known.has(bare)) {
          dangling.push({
            importer,
            name,
            version,
            ...(direct.line === undefined ? {} : { line: direct.line }),
          });
        }
      }
    }
    return {
      kind: 'pnpm',
      path,
      packages: graph.attach(packages),
      importers,
      overrides,
      linksOmitted,
      configDependencies,
      ...(catalogs === undefined ? {} : { catalogs }),
      dangling,
    };
  }

  /**
   * Пакеты документа окружения, до которых доходят только
   * `packageManagerDependencies` (сам pnpm и его платформенные сборки), а не
   * config-зависимости: ключи `имя@версия` по `snapshots`.
   */
  private static packageManagerOnly(root: YamlObject): Set<string> {
    const importers = ParsePnpmLock.isObject(root.importers ?? null) ? (root.importers as YamlObject) : {};
    const body = Object.hasOwn(importers, '.') ? importers['.'] : undefined;
    if (body === undefined || !ParsePnpmLock.isObject(body)) {
      return new Set();
    }
    const snapshots = ParsePnpmLock.isObject(root.snapshots ?? null) ? (root.snapshots as YamlObject) : {};
    const closure = (field: string): Set<string> => {
      const found = new Set<string>();
      const queue: string[] = [];
      const add = (name: string, version: unknown): void => {
        if (typeof version !== 'string') {
          return;
        }
        // Алиас пишется ключом цели (`имя@версия`), обычная запись — версией.
        const key = ParsePnpmLock.bare(
          /^@?[^@]+@/.test(version) && !/^\d/.test(version) ? version : `${name}@${version}`,
        );
        if (!found.has(key)) {
          found.add(key);
          queue.push(key);
        }
      };
      const direct = body[field];
      if (ParsePnpmLock.isObject(direct ?? null)) {
        for (const [name, spec] of Object.entries(direct as YamlObject)) {
          add(name, ParsePnpmLock.isObject(spec) ? spec.version : undefined);
        }
      }
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        const snapshot = Object.entries(snapshots).find(
          ([snapshotKey]) => ParsePnpmLock.bare(snapshotKey) === key,
        )?.[1];
        if (!ParsePnpmLock.isObject(snapshot ?? null)) {
          continue;
        }
        for (const deps of [
          (snapshot as YamlObject).dependencies,
          (snapshot as YamlObject).optionalDependencies,
        ]) {
          if (ParsePnpmLock.isObject(deps ?? null)) {
            for (const [name, version] of Object.entries(deps as YamlObject)) {
              add(name, version);
            }
          }
        }
      }
      return found;
    };
    const config = closure('configDependencies');
    return new Set([...closure('packageManagerDependencies')].filter((key) => !config.has(key)));
  }

  /**
   * Рёбра дерева: v9 — `snapshots.<ключ>` (там же разрешённые peer-зависимости,
   * которые pnpm поставил сам), v6 — записи `packages`. Ребро — имя и версия
   * зависимости, как их пишет pnpm (у алиаса — ключ цели).
   */
  private static edgesOf(
    document: YamlDocument,
    root: YamlObject,
    v6: boolean,
    path: string,
  ): Array<{ from: string; children: Array<[string, string]> }> {
    const sectionName = v6 ? 'packages' : 'snapshots';
    const section = root[sectionName];
    if (section === undefined || section === null) {
      return [];
    }
    if (!ParsePnpmLock.isObject(section)) {
      throw new InputUnreadableError(
        path,
        `${sectionName}: ожидалось отображение`,
        document.lineOf(root, sectionName),
      );
    }
    return Object.entries(section).map(([from, entry]) => {
      const children: Array<[string, string]> = [];
      if (ParsePnpmLock.isObject(entry)) {
        for (const field of ['dependencies', 'optionalDependencies']) {
          const deps = entry[field];
          if (deps === undefined || deps === null) {
            continue;
          }
          if (
            !ParsePnpmLock.isObject(deps) ||
            Object.values(deps).some((value) => typeof value !== 'string')
          ) {
            throw new InputUnreadableError(
              path,
              `${sectionName}.${from}.${field}: ожидалось отображение имён на версии`,
              document.lineOf(entry, field),
            );
          }
          children.push(...(Object.entries(deps) as Array<[string, string]>));
        }
      }
      return { from, children };
    });
  }

  /**
   * Связывает рёбра с пакетами: зависимость `имя: версия` — пакет `имя@версия`,
   * у алиаса (`db: old-orm@1.0.0`, v6 — `/old-orm@1.0.0`) — пакет цели.
   * Ключ ищется точно, затем без суффикса peer-зависимостей. `link:` — проект
   * workspace, а не пакет дерева: ребра нет.
   */
  private static graph(
    packages: readonly LockedPackage[],
    edges: ReadonlyArray<{ from: string; children: ReadonlyArray<[string, string]> }>,
  ): {
    resolve: (name: string, version: string) => string[];
    attach: (list: LockedPackage[]) => LockedPackage[];
  } {
    const exact = new Map<string, string>();
    const byBare = new Map<string, string[]>();
    for (const pkg of packages) {
      const normal = pkg.key.startsWith('/') ? pkg.key.slice(1) : pkg.key;
      exact.set(normal, pkg.key);
      const bare = ParsePnpmLock.bare(pkg.key);
      byBare.set(bare, [...(byBare.get(bare) ?? []), pkg.key]);
    }
    const find = (candidate: string): string[] => {
      const normal = candidate.startsWith('/') ? candidate.slice(1) : candidate;
      const hit = exact.get(normal);
      return hit === undefined ? (byBare.get(ParsePnpmLock.bare(normal)) ?? []) : [hit];
    };
    const resolve = (name: string, version: string): string[] => {
      if (/^link:/i.test(version)) {
        return [];
      }
      const own = find(`${name}@${version}`);
      return own.length > 0 ? own : find(version);
    };
    const children = new Map<string, Set<string>>();
    for (const edge of edges) {
      const owners = find(edge.from);
      for (const owner of owners) {
        const set = children.get(owner) ?? new Set<string>();
        for (const [name, version] of edge.children) {
          for (const child of resolve(name, version)) {
            set.add(child);
          }
        }
        children.set(owner, set);
      }
    }
    return {
      resolve,
      attach: (list) =>
        list.map((pkg) => {
          const deps = children.get(pkg.key);
          return deps === undefined || deps.size === 0 ? pkg : { ...pkg, dependencies: [...deps] };
        }),
    };
  }

  /** Ключ или версия без ведущего `/` (v6) и без суффикса peer-зависимостей `(…)`. */
  private static bare(text: string): string {
    const withoutSlash = text.startsWith('/') ? text.slice(1) : text;
    const peers = withoutSlash.indexOf('(');
    return peers >= 0 ? withoutSlash.slice(0, peers) : withoutSlash;
  }

  private static isObject(value: YamlValue): value is YamlObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private static packagesOf(
    document: YamlDocument,
    root: YamlObject,
    v6: boolean,
    path: string,
  ): LockedPackage[] {
    const section = root.packages;
    if (section === undefined || section === null) {
      return [];
    }
    if (!ParsePnpmLock.isObject(section)) {
      throw new InputUnreadableError(
        path,
        'packages: ожидалось отображение',
        document.lineOf(root, 'packages'),
      );
    }
    return Object.entries(section).map(([key, entry]) => {
      const line = document.lineOf(section, key);
      if (!ParsePnpmLock.isObject(entry)) {
        throw new InputUnreadableError(path, `запись «${key}»: ожидалось отображение`, line);
      }
      const split = PackageKey.split(key);
      const name = typeof entry.name === 'string' ? entry.name : split?.name;
      const version = typeof entry.version === 'string' ? entry.version : split?.version;
      if (name === undefined || version === undefined) {
        throw new InputUnreadableError(path, `запись «${key}»: имя и версия не разобраны`, line);
      }
      const resolution = ParsePnpmLock.isObject(entry.resolution ?? null)
        ? (entry.resolution as YamlObject)
        : {};
      const integrity = typeof resolution.integrity === 'string' ? resolution.integrity : undefined;
      return {
        name,
        version,
        key,
        ...(line === undefined ? {} : { line }),
        source: ParsePnpmLock.sourceOf(resolution),
        ...(integrity === undefined ? {} : { integrity }),
        ...(v6 ? { installScript: ParsePnpmLock.flag(document, entry, 'requiresBuild', path) === true } : {}),
      };
    });
  }

  private static sourceOf(resolution: YamlObject): PackageSource {
    if (resolution.type === 'git') {
      return {
        kind: 'git',
        ...(typeof resolution.repo === 'string' ? { url: resolution.repo } : {}),
        ...(typeof resolution.commit === 'string' ? { commit: resolution.commit } : {}),
      };
    }
    if (resolution.type === 'directory' || typeof resolution.directory === 'string') {
      return {
        kind: 'directory',
        ...(typeof resolution.directory === 'string' ? { url: resolution.directory } : {}),
      };
    }
    if (resolution.type !== undefined) {
      return { kind: 'unknown', url: `type: ${valueText(resolution.type)}` };
    }
    if (typeof resolution.tarball === 'string') {
      if (/^file:/i.test(resolution.tarball)) {
        return { kind: 'file', url: resolution.tarball };
      }
      const source = PackageOrigin.fromUrl(resolution.tarball);
      return source.kind === 'tarball' ? source : { kind: 'unknown', url: resolution.tarball };
    }
    return typeof resolution.integrity === 'string' ? { kind: 'registry-default' } : { kind: 'unknown' };
  }

  private static importersOf(
    document: YamlDocument,
    root: YamlObject,
    path: string,
  ): Array<[string, Record<string, LockedDirect>]> {
    // lockfile v6 одного проекта пишет зависимости в корень документа, без importers.
    const section = ParsePnpmLock.isObject(root.importers ?? null)
      ? (root.importers as YamlObject)
      : DEPENDENCY_FIELDS.some((field) => root[field] !== undefined)
        ? { '.': root }
        : {};
    return Object.entries(section).map(([importer, body]) => {
      if (!ParsePnpmLock.isObject(body)) {
        throw new InputUnreadableError(path, `importers.${importer}: ожидалось отображение`);
      }
      const directs: Record<string, LockedDirect> = Object.create(null);
      for (const field of DEPENDENCY_FIELDS) {
        for (const [name, entry] of ParsePnpmLock.specifiedOf(
          document,
          body,
          field,
          `importers.${importer}`,
          path,
        )) {
          directs[name] = { field, ...entry };
        }
      }
      return [importer, directs];
    });
  }

  /** `catalogs.<каталог>.<пакет>: {specifier, version}`; раздела нет — `undefined`, иная форма — отказ. */
  private static catalogsOf(
    document: YamlDocument,
    root: YamlObject,
    path: string,
  ): Record<string, Record<string, LockedCatalogEntry>> | undefined {
    const section = root.catalogs;
    if (section === undefined || section === null) {
      return undefined;
    }
    if (!ParsePnpmLock.isObject(section)) {
      throw new InputUnreadableError(
        path,
        'catalogs: ожидалось отображение',
        document.lineOf(root, 'catalogs'),
      );
    }
    const result: Record<string, Record<string, LockedCatalogEntry>> = Object.create(null);
    for (const name of Object.keys(section)) {
      const entries: Record<string, LockedCatalogEntry> = Object.create(null);
      for (const [pkg, entry] of ParsePnpmLock.specifiedOf(document, section, name, 'catalogs', path)) {
        entries[pkg] = {
          specifier: entry.specifier,
          ...(entry.line === undefined ? {} : { line: entry.line }),
        };
      }
      result[name] = entries;
    }
    return result;
  }

  private static configDependenciesOf(
    document: YamlDocument,
    root: YamlObject,
    path: string,
  ): Record<string, LockedConfigDependency> {
    const importers = ParsePnpmLock.isObject(root.importers ?? null) ? (root.importers as YamlObject) : {};
    const body = Object.hasOwn(importers, '.') ? importers['.'] : undefined;
    if (body === undefined || !ParsePnpmLock.isObject(body)) {
      return {};
    }
    return Object.fromEntries(
      ParsePnpmLock.specifiedOf(document, body, 'configDependencies', 'importers..', path),
    );
  }

  /** Записи `имя: {specifier, version}` раздела `field` проекта. */
  private static specifiedOf(
    document: YamlDocument,
    body: YamlObject,
    field: string,
    where: string,
    path: string,
  ): Array<[string, { specifier: string; version?: string; line?: number }]> {
    const deps = body[field];
    if (deps === undefined || deps === null) {
      return [];
    }
    if (!ParsePnpmLock.isObject(deps)) {
      throw new InputUnreadableError(
        path,
        `${where}.${field}: ожидалось отображение`,
        document.lineOf(body, field),
      );
    }
    return Object.entries(deps).map(([name, spec]) => {
      const line = document.lineOf(deps, name);
      if (!ParsePnpmLock.isObject(spec) || typeof spec.specifier !== 'string') {
        throw new InputUnreadableError(path, `${where}.${field}.${name}: нет specifier`, line);
      }
      return [
        name,
        {
          specifier: spec.specifier,
          ...(ParsePnpmLock.optionalString(spec.version, `${where}.${field}.${name}.version`, path, line) ??
            {}),
          ...(line === undefined ? {} : { line }),
        },
      ];
    });
  }

  /**
   * Флаг: `true`/`false` или нет ключа. Иное (`yes`, `on`) — отказ: pnpm 12
   * читает такие значения флагом, js-yaml — строкой, гейт не угадывает.
   */
  private static flag(
    document: YamlDocument,
    owner: YamlObject,
    key: string,
    path: string,
  ): boolean | undefined {
    const value = owner[key];
    if (value === undefined || value === null || typeof value === 'boolean') {
      return value ?? undefined;
    }
    throw new InputUnreadableError(path, `${key}: ожидалось true или false`, document.lineOf(owner, key));
  }

  private static optionalString(
    value: YamlValue | undefined,
    where: string,
    path: string,
    line: number | undefined,
  ): { version: string } | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new InputUnreadableError(path, `${where}: ожидалась строка`, line);
    }
    return { version: value };
  }

  /** Отображение строк верхнего уровня (`overrides`); иное — отказ. */
  private static stringsOf(
    document: YamlDocument,
    root: YamlObject,
    key: string,
    path: string,
  ): Record<string, string> {
    const section = root[key];
    if (section === undefined || section === null) {
      return {};
    }
    if (
      !ParsePnpmLock.isObject(section) ||
      Object.values(section).some((value) => typeof value !== 'string')
    ) {
      throw new InputUnreadableError(path, `${key}: ожидалось отображение строк`, document.lineOf(root, key));
    }
    return section as Record<string, string>;
  }
}
