import { posix } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import type { BerryLocator } from '../types/berry-locator.type';
import type { DanglingReference } from '../types/dangling-reference.type';
import type { LockedDirect } from '../types/locked-direct.type';
import type { LockedPackage } from '../types/locked-package.type';
import type { Lockfile } from '../types/lockfile.type';
import type { PackageSource } from '../types/package-source.type';
import type { YamlDocument } from '../types/yaml-document.type';
import type { YamlObject } from '../types/yaml-object.type';
import { valueText } from '../value-text';
import { YamlSubset } from '../yaml/yaml-subset';
import { YamlSubsetError } from '../yaml/yaml-subset.error';
import { PackageOrigin } from './package-origin';

/**
 * yarn.lock yarn 2+ (berry): YAML с `__metadata` (`version` формата, `cacheKey`)
 * и записями «дескрипторы через запятую → пакет». Дескриптор —
 * `имя@протокол:диапазон[::привязка]`; у пакета `resolution` — локатор
 * `имя@протокол:ссылка[#…][::параметры]`, `checksum` — sha512 архива в кэше
 * yarn (у yarn 4.1+ с префиксом `cacheKey/`), `linkType` (`hard` — пакет,
 * `soft` — проект workspace, ссылка, портал).
 *
 * Источник — по протоколу локатора: `npm:` — реестр установки; `workspace:` —
 * проект (запись даёт прямые зависимости проекта: yarn пишет их одним списком
 * без деления на поля); `patch:` — источник исходного пакета; `link:` —
 * ссылка, `portal:` и `file:` — каталог или архив (путь от проекта, указанного
 * в привязке `locator=`); `exec:` — пакет, который yarn собирает, исполняя
 * скрипт, — нераспознанный источник; адрес с `#commit=` — git; прочий http(s)
 * — архив по адресу. Форматы 8, 9 (yarn 4.14) и 10 (yarn 4.15+) по записям
 * одинаковы (замер: один проект, записанный yarn 4.13.0, 4.14.1 и 4.18.1, —
 * файлы отличаются только `__metadata.version`); меняются умолчания настроек
 * (см. {@link Lockfile.berryFormat}). Версия формата вне 4–10, неизвестный протокол в
 * `resolution`, запись без него — отказ: формат читается целиком или никак.
 */
export class ParseYarnBerryLock {
  public static readonly VERSIONS = ['4', '5', '6', '7', '8', '9', '10'] as const;

  public static parse(text: string, path: string): Lockfile {
    let document: YamlDocument;
    try {
      document = YamlSubset.parseFailsafe(text);
    } catch (error) {
      if (error instanceof YamlSubsetError) {
        throw new InputUnreadableError(path, error.detail, error.line);
      }
      throw error;
    }
    const root = document.value;
    if (!ParseYarnBerryLock.isObject(root) || !ParseYarnBerryLock.isObject(root.__metadata ?? null)) {
      throw new InputUnreadableError(path, 'yarn.lock yarn 2+: нет раздела __metadata');
    }
    const metadata = root.__metadata as YamlObject;
    const version = metadata.version;
    if (
      typeof version !== 'string' ||
      !(ParseYarnBerryLock.VERSIONS as readonly string[]).includes(version)
    ) {
      throw new InputUnreadableError(
        path,
        `__metadata.version «${valueText(version)}» не поддерживается (поддержаны ${ParseYarnBerryLock.VERSIONS.join(', ')})`,
        document.lineOf(metadata, 'version'),
      );
    }
    const cacheKey = metadata.cacheKey;
    if (cacheKey !== undefined && cacheKey !== null && typeof cacheKey !== 'string') {
      throw new InputUnreadableError(
        path,
        '__metadata.cacheKey: ожидалась строка',
        document.lineOf(metadata, 'cacheKey'),
      );
    }
    const entries: Array<{ key: string; line?: number; body: YamlObject; locator: BerryLocator }> = [];
    const descriptors = new Set<string>();
    for (const [key, body] of Object.entries(root)) {
      if (key === '__metadata') {
        continue;
      }
      const line = document.lineOf(root, key);
      const fail = (detail: string): never => {
        throw new InputUnreadableError(path, `запись «${key}»: ${detail}`, line);
      };
      if (!ParseYarnBerryLock.isObject(body)) {
        fail('ожидалось отображение');
      }
      const entry = body as YamlObject;
      if (typeof entry.resolution !== 'string' || typeof entry.version !== 'string') {
        fail('нет resolution или version');
      }
      const locator =
        ParseYarnBerryLock.locator(entry.resolution as string) ?? fail('resolution не разобран');
      for (const descriptor of key.split(/,\s*/)) {
        const parsed = ParseYarnBerryLock.splitIdent(descriptor);
        if (parsed === undefined) {
          fail(`дескриптор «${descriptor}» не разобран`);
        }
        descriptors.add(ParseYarnBerryLock.unbound(descriptor));
      }
      entries.push({ key, ...(line === undefined ? {} : { line }), body: entry, locator });
    }
    const workspaces = new Map<string, string>();
    for (const { locator } of entries) {
      if (locator.protocol === 'workspace') {
        workspaces.set(locator.name, ParseYarnBerryLock.workspacePath(locator.reference));
      }
    }
    const packages: LockedPackage[] = [];
    const importers: Record<string, Record<string, LockedDirect>> = Object.create(null);
    const dangling: DanglingReference[] = [];
    // Дескриптор (как есть и без привязки `::locator=`) → ключ записи: по нему разрешаются рёбра.
    const keyOf = new Map<string, string>();
    for (const { key } of entries) {
      for (const descriptor of key.split(/,\s*/)) {
        keyOf.set(descriptor, key);
        if (!keyOf.has(ParseYarnBerryLock.unbound(descriptor))) {
          keyOf.set(ParseYarnBerryLock.unbound(descriptor), key);
        }
      }
    }
    // Проект workspace — не пакет дерева: его зависимости судятся от самого проекта.
    const projects = new Set(
      entries.filter(({ locator }) => locator.protocol === 'workspace').map(({ key }) => key),
    );
    const targetOf = (name: string, range: string): string | undefined => {
      const key =
        keyOf.get(`${name}@${range}`) ?? keyOf.get(`${name}@${ParseYarnBerryLock.descriptorRange(range)}`);
      return key === undefined || projects.has(key) ? undefined : key;
    };
    for (const { key, line, body, locator } of entries) {
      if (locator.protocol === 'workspace') {
        const importer = ParseYarnBerryLock.workspacePath(locator.reference);
        const directs = ParseYarnBerryLock.directsOf(document, body, key, path);
        importers[importer] = directs;
        for (const [name, direct] of Object.entries(directs)) {
          const target = targetOf(name, direct.specifier);
          if (target !== undefined) {
            directs[name] = { ...direct, target };
          }
          if (
            !descriptors.has(`${name}@${direct.specifier}`) &&
            !descriptors.has(`${name}@${ParseYarnBerryLock.descriptorRange(direct.specifier)}`)
          ) {
            dangling.push({
              importer,
              name,
              version: direct.specifier,
              ...(direct.line === undefined ? {} : { line: direct.line }),
            });
          }
        }
        continue;
      }
      const checksum = body.checksum;
      if (checksum !== undefined && checksum !== null && typeof checksum !== 'string') {
        throw new InputUnreadableError(path, `запись «${key}»: checksum не строка`, line);
      }
      const requires = new Set<string>();
      for (const [name, direct] of Object.entries(ParseYarnBerryLock.directsOf(document, body, key, path))) {
        const target = targetOf(name, direct.specifier);
        if (target !== undefined && target !== key) {
          requires.add(target);
        }
      }
      packages.push({
        name: locator.name,
        version: body.version as string,
        key,
        ...(requires.size === 0 ? {} : { dependencies: [...requires] }),
        ...(line === undefined ? {} : { line }),
        source: ParseYarnBerryLock.sourceOf(locator, workspaces, key, path, line),
        ...(typeof checksum === 'string' ? { integrity: checksum } : {}),
        ...(typeof body.conditions === 'string' ? { conditions: body.conditions } : {}),
      });
    }
    return {
      kind: 'yarn-berry',
      path,
      packages,
      importers,
      directFieldsMerged: true,
      ...(typeof cacheKey === 'string' ? { cacheKey } : {}),
      selectors: descriptors,
      dangling,
      berryFormat: Number(version),
    };
  }

  /**
   * Диапазон, как yarn пишет его в дескриптор: у диапазона реестра без
   * протокола — `npm:` (формат 8; формат 4–6 пишет диапазон как есть).
   */
  public static descriptorRange(specifier: string): string {
    const spec = specifier.trim();
    return /^[a-z][a-z0-9+.-]*:/i.test(spec) || PackageOrigin.fromSpecifier(spec).kind !== 'registry-default'
      ? spec
      : `npm:${spec}`;
  }

  /** Локатор `имя@протокол:ссылка[#…][::параметры]`. */
  private static locator(text: string): BerryLocator | undefined {
    const ident = ParseYarnBerryLock.splitIdent(text);
    if (ident === undefined) {
      return undefined;
    }
    const match = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(ident.range);
    if (match === null) {
      return undefined;
    }
    const [bodyAndHash = '', params = ''] = (match[2] as string).split('::');
    const hashAt = bodyAndHash.indexOf('#');
    return {
      name: ident.name,
      protocol: (match[1] as string).toLowerCase(),
      reference: hashAt >= 0 ? bodyAndHash.slice(0, hashAt) : bodyAndHash,
      selector: hashAt >= 0 ? bodyAndHash.slice(hashAt + 1) : undefined,
      params: new URLSearchParams(params),
      raw: ident.range,
    };
  }

  /** `имя@остаток`, имя — `x` или `@scope/x`. */
  private static splitIdent(text: string): { name: string; range: string } | undefined {
    const at = text.startsWith('@') ? text.indexOf('@', text.indexOf('/') + 1) : text.indexOf('@');
    const name = at > 0 ? text.slice(0, at) : '';
    if (
      name === '' ||
      (name.startsWith('@') && !/^@[^/@]+\/[^/@]+$/.test(name)) ||
      /[\s:/]/.test(name.replace(/^@[^/]+\//, ''))
    ) {
      return undefined;
    }
    return { name, range: text.slice(at + 1) };
  }

  /** Дескриптор без привязки к проекту (`::locator=…`), как его пишет workspace в dependencies. */
  private static unbound(descriptor: string): string {
    return descriptor.replace(/::.*$/, '');
  }

  private static workspacePath(reference: string): string {
    const path = posix.normalize(decodeURIComponent(reference));
    return path === '' ? '.' : path;
  }

  private static sourceOf(
    locator: BerryLocator,
    workspaces: ReadonlyMap<string, string>,
    key: string,
    path: string,
    line: number | undefined,
  ): PackageSource {
    const fail = (detail: string): never => {
      throw new InputUnreadableError(path, `запись «${key}»: ${detail}`, line);
    };
    const importer = (): string => {
      const bound = locator.params.get('locator');
      if (bound === null) {
        return '.';
      }
      const owner = ParseYarnBerryLock.locator(bound);
      if (owner?.protocol !== 'workspace') {
        return fail(`привязка «${bound}» — не проект workspace`);
      }
      return workspaces.get(owner.name) ?? ParseYarnBerryLock.workspacePath(owner.reference);
    };
    switch (locator.protocol) {
      case 'npm':
        return /^https?:/i.test(locator.reference)
          ? PackageOrigin.fromUrl(locator.reference)
          : { kind: 'registry-default' };
      case 'patch': {
        const inner = ParseYarnBerryLock.locator(decodeURIComponent(locator.reference));
        if (inner === undefined || inner.protocol === 'patch') {
          return fail('исходный пакет patch: не разобран');
        }
        return ParseYarnBerryLock.sourceOf(inner, workspaces, key, path, line);
      }
      case 'link':
        return { kind: 'link', url: PackageOrigin.linkTarget(importer(), locator.reference) };
      case 'portal':
        return { kind: 'directory', url: PackageOrigin.linkTarget(importer(), locator.reference) };
      case 'file': {
        const target = PackageOrigin.linkTarget(importer(), locator.reference);
        return /\.(?:tgz|tar\.gz|tar)$/i.test(target)
          ? { kind: 'file', url: `file:${target}` }
          : { kind: 'directory', url: target };
      }
      case 'exec':
        return { kind: 'unknown', url: `exec:${locator.reference}` };
      default: {
        const commit =
          locator.selector === undefined ? null : new URLSearchParams(locator.selector).get('commit');
        if (commit !== null) {
          return { kind: 'git', url: `${locator.protocol}:${locator.reference}`, commit };
        }
        if (locator.protocol === 'http' || locator.protocol === 'https') {
          return PackageOrigin.fromUrl(locator.raw);
        }
        return fail(`протокол «${locator.protocol}:» не поддерживается`);
      }
    }
  }

  private static directsOf(
    document: YamlDocument,
    body: YamlObject,
    key: string,
    path: string,
  ): Record<string, LockedDirect> {
    const directs: Record<string, LockedDirect> = Object.create(null);
    const deps = body.dependencies;
    if (deps === undefined || deps === null) {
      return directs;
    }
    if (!ParseYarnBerryLock.isObject(deps)) {
      throw new InputUnreadableError(path, `запись «${key}»: dependencies — ожидалось отображение`);
    }
    for (const [name, specifier] of Object.entries(deps)) {
      const line = document.lineOf(deps, name);
      if (typeof specifier !== 'string') {
        throw new InputUnreadableError(
          path,
          `запись «${key}»: dependencies.${name} — ожидалась строка`,
          line,
        );
      }
      directs[name] = { field: 'dependencies', specifier, ...(line === undefined ? {} : { line }) };
    }
    return directs;
  }

  private static isObject(value: unknown): value is YamlObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
