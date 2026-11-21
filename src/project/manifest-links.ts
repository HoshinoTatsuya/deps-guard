import { PackageOrigin } from '../lockfile/package-origin';
import type { LockedPackage } from '../types/locked-package.type';
import type { Lockfile } from '../types/lockfile.type';
import type { Manifest } from '../types/manifest.type';
import { DirectDependencies } from './direct-dependencies';

/**
 * Ссылки `link:` из package.json, которых нет в lock-файле: так pnpm пишет при
 * `excludeLinksFromLockfile: true`. Без них ссылку за пределы репозитория не
 * судило бы правило источников.
 */
export class ManifestLinks {
  public static missing(manifests: readonly Manifest[], lock: Lockfile): LockedPackage[] {
    return manifests.flatMap((manifest) => {
      const locked = lock.importers?.[manifest.importer];
      return DirectDependencies.of(manifest)
        .filter((dep) => /^link:/i.test(dep.specifier) && !(locked && Object.hasOwn(locked, dep.name)))
        .map((dep) => ({
          name: dep.name,
          version: dep.specifier,
          key: `${manifest.importer} → ${dep.name}`,
          source: {
            kind: 'link' as const,
            url: PackageOrigin.linkTarget(manifest.importer, dep.specifier.slice('link:'.length)),
          },
        }));
    });
  }
}
