import { DirectDependencies } from '../project/direct-dependencies';
import type { ChainRoot } from '../types/chain-root.type';
import type { DependencyChain } from '../types/dependency-chain.type';
import type { Lockfile } from '../types/lockfile.type';
import type { Manifest } from '../types/manifest.type';

/**
 * Цепочки «прямая зависимость → … → пакет» по рёбрам lock-файла
 * (`LockedPackage.dependencies`). Начала — прямые зависимости проектов,
 * разрешённые разборщиком (`LockedDirect.target`, config-зависимости pnpm);
 * yarn 1 прямых зависимостей не хранит — они берутся из package.json проектов
 * и находятся по селектору `имя@спецификатор` записи.
 *
 * Поиск — обратный обход в ширину от искомого пакета: у каждого начала —
 * кратчайшая цепочка, время линейно по числу рёбер.
 */
export class DependencyChains {
  private readonly parents = new Map<string, Set<string>>();

  private readonly roots: ChainRoot[];

  private constructor(lock: Lockfile, manifests: readonly Manifest[]) {
    for (const pkg of lock.packages) {
      for (const child of pkg.dependencies ?? []) {
        const set = this.parents.get(child) ?? new Set<string>();
        set.add(pkg.key);
        this.parents.set(child, set);
      }
    }
    this.roots = DependencyChains.rootsOf(lock, manifests);
  }

  public static of(lock: Lockfile, manifests: readonly Manifest[]): DependencyChains {
    return new DependencyChains(lock, manifests);
  }

  /** Кратчайшая цепочка от каждого начала, из которого пакет `key` достижим; короткие — первыми. */
  public chainsTo(key: string): DependencyChain[] {
    const next = new Map<string, string | undefined>([[key, undefined]]);
    const queue = [key];
    for (let at = 0; at < queue.length; at += 1) {
      const current = queue[at] as string;
      for (const parent of this.parents.get(current) ?? []) {
        if (!next.has(parent)) {
          next.set(parent, current);
          queue.push(parent);
        }
      }
    }
    const chains: DependencyChain[] = [];
    for (const root of this.roots) {
      if (!next.has(root.key)) {
        continue;
      }
      const keys: string[] = [];
      for (let step: string | undefined = root.key; step !== undefined; step = next.get(step)) {
        keys.push(step);
      }
      chains.push({ root, keys });
    }
    return chains.sort(
      (a, b) =>
        a.keys.length - b.keys.length ||
        a.root.importer.localeCompare(b.root.importer) ||
        a.root.name.localeCompare(b.root.name),
    );
  }

  private static rootsOf(lock: Lockfile, manifests: readonly Manifest[]): ChainRoot[] {
    const roots: ChainRoot[] = [];
    if (lock.importers !== undefined) {
      for (const [importer, directs] of Object.entries(lock.importers)) {
        // yarn 2+ пишет прямые зависимости одним списком: поле — из package.json проекта.
        const manifest = lock.directFieldsMerged
          ? manifests.find((candidate) => candidate.importer === importer)
          : undefined;
        const fields = new Map(
          manifest === undefined ? [] : DirectDependencies.of(manifest).map((dep) => [dep.name, dep.field]),
        );
        for (const [name, direct] of Object.entries(directs)) {
          if (direct.target !== undefined) {
            roots.push({ importer, field: fields.get(name) ?? direct.field, name, key: direct.target });
          }
        }
      }
    } else {
      // yarn 1: ключ записи — её селекторы через «, ».
      const bySelector = new Map<string, string>();
      for (const pkg of lock.packages) {
        for (const selector of pkg.key.split(', ')) {
          bySelector.set(selector, pkg.key);
        }
      }
      for (const manifest of manifests) {
        for (const dep of DirectDependencies.of(manifest)) {
          const key = bySelector.get(`${dep.name}@${dep.specifier}`);
          if (key !== undefined) {
            roots.push({ importer: manifest.importer, field: dep.field, name: dep.name, key });
          }
        }
      }
    }
    for (const [name, config] of Object.entries(lock.configDependencies ?? {})) {
      if (config.target !== undefined) {
        roots.push({ importer: '.', field: 'configDependencies', name, key: config.target });
      }
    }
    return roots;
  }
}
