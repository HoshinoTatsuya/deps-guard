import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DependencyIdentity } from '../project/dependency-identity';
import { DirectDependencies } from '../project/direct-dependencies';
import type { Manifest } from '../types/manifest.type';
import type { YamlObject } from '../types/yaml-object.type';

/**
 * Файл базовой линии: `{ "dependencies": ["имя", …] }` — предметы прямых
 * зависимостей всех package.json проекта ({@link DependencyIdentity}: имя
 * пакета реестра, у `npm:`-алиаса — имя цели, у пакета не из реестра —
 * `имя@источник`) и config-зависимостей pnpm на момент фиксации. Пишет `deps-guard baseline`;
 * новые относительно него зависимости требуют записи-причины.
 */
export class BaselineFile {
  public static read(root: string, file: string): Set<string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolve(root, file), 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`базовая линия ${file} не прочитана: ${(error as Error).message}`);
    }
    const list = (parsed as { dependencies?: unknown } | null)?.dependencies;
    if (!Array.isArray(list) || list.some((name) => typeof name !== 'string')) {
      throw new Error(`базовая линия ${file}: ожидалось { "dependencies": [имена] }`);
    }
    return new Set(list as string[]);
  }

  /** Текст файла базовой линии для текущих package.json (отсортирован, без повторов). */
  public static render(
    manifests: readonly Manifest[],
    configDependencies: readonly string[] = [],
    pnpmSettings: YamlObject = Object.create(null),
  ): string {
    const names = [
      ...new Set([
        ...manifests.flatMap((manifest) =>
          DirectDependencies.of(manifest).map((dep) =>
            DependencyIdentity.of(dep.name, dep.specifier, manifest.importer, pnpmSettings),
          ),
        ),
        ...configDependencies,
      ]),
    ];
    return `${JSON.stringify({ dependencies: names.sort() }, null, 2)}\n`;
  }

  public static write(
    root: string,
    file: string,
    manifests: readonly Manifest[],
    configDependencies: readonly string[] = [],
    pnpmSettings: YamlObject = Object.create(null),
  ): void {
    // Абсолютный путь — как есть: join склеил бы его с корнем.
    writeFileSync(resolve(root, file), BaselineFile.render(manifests, configDependencies, pnpmSettings));
  }
}
