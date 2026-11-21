import { PopularPackages } from '../names/popular-packages';
import { ReadManifests } from '../project/read-manifests';
import type { LockedPackage } from '../types/locked-package.type';
import type { Lockfile } from '../types/lockfile.type';
import type { Manifest } from '../types/manifest.type';
import type { PackageSource } from '../types/package-source.type';
import type { RuleContext } from '../types/rule-context.type';

/** Контекст правила для спек: без диска, с явными подменами. */
export class RuleContextOf {
  /** «Сейчас» спек — фиксировано: свежесть не зависит от дня прогона. */
  public static readonly NOW = new Date('2026-11-15T00:00:00Z');

  public static make(overrides: Partial<RuleContext> = {}): RuleContext {
    return {
      root: '/nonexistent-deps-guard-root',
      config: {},
      configPath: 'deps-guard.json',
      lock: RuleContextOf.lock([]),
      manifests: [RuleContextOf.manifest({})],
      metadata: new Map(),
      now: RuleContextOf.NOW,
      popular: () => PopularPackages.load(PopularPackages.BUILTIN),
      gitShow: () => {
        throw new Error('git в этой спеке не используется');
      },
      gitList: () => {
        throw new Error('git в этой спеке не используется');
      },
      ...overrides,
    };
  }

  public static lock(packages: LockedPackage[], extra: Partial<Lockfile> = {}): Lockfile {
    return { kind: 'pnpm', path: 'pnpm-lock.yaml', packages, importers: { '.': {} }, ...extra };
  }

  public static manifest(json: Record<string, unknown>, importer = '.'): Manifest {
    const path = importer === '.' ? 'package.json' : `${importer}/package.json`;
    return ReadManifests.fromText(importer, path, JSON.stringify(json, null, 2));
  }

  public static pkg(
    name: string,
    version: string,
    source: PackageSource = { kind: 'registry-default' },
    extra: { [K in keyof LockedPackage]?: LockedPackage[K] | undefined } = {},
  ): LockedPackage {
    const merged: Record<string, unknown> = {
      name,
      version,
      key: `${name}@${version}`,
      source,
      integrity:
        'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      ...extra,
    };
    // `integrity: undefined` в спеке значит «поля нет», как у записи lock-файла без него.
    return Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ) as unknown as LockedPackage;
  }
}
