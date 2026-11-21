import { INSTALL_HOOKS } from '../constants/install-hooks.constant';
import type { FetchMetadataOptions } from '../types/fetch-metadata-options.type';
import type { LockedPackage } from '../types/locked-package.type';
import type { PackageMetadata } from '../types/package-metadata.type';

/**
 * Метаданные реестра для пакетов lock-файла: даты публикации ровно тех версий,
 * что стоят в дереве, и признак install-скрипта. Каждый запрос — со своим
 * потолком: зависший реестр даёт ошибку по пакету, а не вечное ожидание.
 * Пакет, который не удалось получить, попадает в `errors`, а не в кэш с
 * пустыми данными: пустая запись выглядела бы проверенной.
 *
 * Документ берётся из того реестра, откуда пакет ставится: архив по адресу —
 * из реестра, которому принадлежит адрес (раскладка `<реестр>/<имя>/-/<файл>`;
 * адрес не в раскладке — ошибка, а не данные одноимённого публичного пакета);
 * пакет scope — из `scopeRegistries`; остальное — из `registry`.
 */
export class FetchMetadata {
  public static readonly DEFAULT_TIMEOUT_MS = 15_000;

  public static async run(
    options: FetchMetadataOptions,
  ): Promise<{ metadata: Record<string, PackageMetadata>; errors: string[] }> {
    const versions = new Map<string, Set<string>>();
    const origins = new Map<string, Set<string>>();
    const errors: string[] = [];
    for (const pkg of options.packages) {
      if (pkg.source.kind === 'registry-default' || pkg.source.kind === 'tarball') {
        const origin = FetchMetadata.registryOf(options, pkg);
        if (origin === undefined) {
          errors.push(
            `${pkg.name}@${pkg.version}: адрес архива ${pkg.source.url ?? ''} не в раскладке реестра — откуда брать метаданные, неизвестно`,
          );
          continue;
        }
        const set = versions.get(pkg.name) ?? new Set<string>();
        set.add(pkg.version);
        versions.set(pkg.name, set);
        origins.set(pkg.name, (origins.get(pkg.name) ?? new Set<string>()).add(origin));
      }
    }
    for (const [name, set] of origins) {
      if (set.size > 1) {
        versions.delete(name);
        errors.push(
          `${name}: пакет ставится из нескольких реестров (${[...set].sort().join(', ')}) — метаданные неоднозначны`,
        );
      }
    }
    const metadata: Record<string, PackageMetadata> = {};
    const queue = [...versions.keys()].sort();
    const worker = async (): Promise<void> => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        try {
          const registry = [...(origins.get(name) ?? [])][0] as string;
          const { found, missing } = await FetchMetadata.one(
            options,
            registry,
            name,
            versions.get(name) ?? new Set(),
          );
          if (Object.keys(found.time ?? {}).length > 0) {
            metadata[name] = found;
          }
          if (missing.length > 0) {
            errors.push(
              `${name}: в документе реестра нет версий ${missing.join(', ')} (снята или чужой реестр)`,
            );
          }
        } catch (error) {
          errors.push(`${name}: ${(error as Error).message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 8) }, () => worker()));
    return { metadata, errors: errors.sort() };
  }

  /** Реестр, из которого ставится пакет; `undefined` — архив по адресу вне раскладки реестра. */
  private static registryOf(options: FetchMetadataOptions, pkg: LockedPackage): string | undefined {
    if (pkg.source.kind === 'tarball') {
      const url = pkg.source.url ?? '';
      const marker = `/${pkg.name}/-/`;
      // `%2f` и `%2F` — одно и то же процентное кодирование `/`.
      const encoded = `/${pkg.name.replace('/', '%2f')}/-/`;
      const at =
        url.indexOf(marker) >= 0 ? url.indexOf(marker) : url.toLowerCase().indexOf(encoded.toLowerCase());
      return at > 0 && URL.canParse(url) ? FetchMetadata.base(url.slice(0, at + 1)) : undefined;
    }
    const scope = pkg.name.startsWith('@') ? pkg.name.slice(0, pkg.name.indexOf('/')) : undefined;
    const scoped = scope === undefined ? undefined : options.scopeRegistries?.[scope];
    return FetchMetadata.base(scoped ?? options.registry);
  }

  private static base(registry: string): string {
    return registry.endsWith('/') ? registry : `${registry}/`;
  }

  private static async one(
    options: FetchMetadataOptions,
    base: string,
    name: string,
    wanted: Set<string>,
  ): Promise<{ found: PackageMetadata; missing: string[] }> {
    const url = new URL(name.replace('/', '%2f'), base);
    // Учётка в адресе (`https://user:pass@…` из .npmrc): fetch такой адрес не
    // принимает. Она не используется и никуда не уходит — Authorization задаёт
    // DEPS_GUARD_REGISTRY_AUTH (`options.authorization`).
    url.username = '';
    url.password = '';
    const ownRegistry = base === FetchMetadata.base(options.registry);
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(options.authorization === undefined || !ownRegistry
          ? {}
          : { authorization: options.authorization }),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? FetchMetadata.DEFAULT_TIMEOUT_MS),
      redirect: 'error',
    });
    if (!response.ok) {
      throw new Error(`реестр ответил ${response.status}`);
    }
    const document = (await response.json()) as {
      time?: Record<string, unknown>;
      versions?: Record<
        string,
        { hasInstallScript?: unknown; scripts?: Record<string, unknown>; gypfile?: unknown }
      >;
    };
    const time: Record<string, string> = {};
    const versions: Record<string, { hasInstallScript: boolean }> = {};
    const missing: string[] = [];
    for (const version of [...wanted].sort()) {
      const stamp = FetchMetadata.own(document.time, version);
      const manifest = FetchMetadata.own(document.versions, version);
      // Версия без даты или без манифеста не пишется вовсе: пустая запись выглядела бы проверенной.
      if (typeof stamp !== 'string' || typeof manifest !== 'object' || manifest === null) {
        missing.push(version);
        continue;
      }
      time[version] = stamp;
      const scripts = manifest.scripts ?? {};
      versions[version] = {
        hasInstallScript:
          manifest.hasInstallScript === true ||
          manifest.gypfile === true ||
          INSTALL_HOOKS.some((hook) => typeof FetchMetadata.own(scripts, hook) === 'string'),
      };
    }
    return { found: { time, versions }, missing };
  }

  private static own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
    return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
  }
}
