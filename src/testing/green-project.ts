import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ParsePnpmLock } from '../lockfile/parse-pnpm-lock';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import type { PackageMetadata } from '../types/package-metadata.type';
import { TempDir } from './temp-dir';

/**
 * Проект из фикстуры `fixtures/pnpm-project/head` (настоящий lock pnpm 12) с
 * настройкой, на которой гейт обязан быть зелёным: проверка, что он умеет
 * быть зелёным, — половина доказательства, что красный цвет что-то значит.
 */
export class GreenProject {
  public static readonly NOW = new Date('2026-11-15T00:00:00Z');

  public static readonly REASON = 'проверено вручную: пакет нужен проекту и его источник известен';

  public static config(): DepsGuardConfig {
    return {
      newDependencies: {
        baseline: { file: 'deps-guard.baseline.json' },
        allow: {
          'native-hook@file:vendor/native-hook': GreenProject.REASON,
          'plain-lib@file:vendor/plain-lib': GreenProject.REASON,
          semver: GreenProject.REASON,
        },
      },
      sources: {
        registries: ['https://registry.npmjs.org/'],
        defaultRegistry: 'https://registry.npmjs.org/',
        allow: {
          'native-hook@file:vendor/native-hook': GreenProject.REASON,
          'plain-lib@file:vendor/plain-lib': GreenProject.REASON,
        },
      },
      freshness: { metadataFile: 'deps-guard.metadata.json' },
      floatingRanges: { allow: { semver: GreenProject.REASON } },
      bannedPackages: [{ name: 'request', reason: 'снят с поддержки автором: вместо него встроенный fetch' }],
    };
  }

  /** Метаданные всех реестровых пакетов lock-файла: опубликованы год назад, без скриптов. */
  public static metadata(dir: string, publishedDaysAgo = 365): Record<string, PackageMetadata> {
    const lock = ParsePnpmLock.parse(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8'), 'pnpm-lock.yaml');
    const stamp = new Date(GreenProject.NOW.getTime() - publishedDaysAgo * 24 * 60 * 60 * 1000).toISOString();
    const result: Record<string, PackageMetadata> = {};
    for (const pkg of lock.packages) {
      if (pkg.source.kind === 'registry-default') {
        result[pkg.name] = {
          time: { [pkg.version]: stamp },
          versions: { [pkg.version]: { hasInstallScript: false } },
        };
      }
    }
    return result;
  }

  /** Каталог с фикстурой, настройкой, базовой линией (debug, ms) и метаданными. */
  public static create(): string {
    const dir = TempDir.create();
    TempDir.copyFixture('pnpm-project/head', dir);
    TempDir.write(dir, {
      'deps-guard.json': JSON.stringify(GreenProject.config(), null, 2),
      'deps-guard.baseline.json': JSON.stringify({ dependencies: ['debug', 'ms'] }),
    });
    TempDir.write(dir, { 'deps-guard.metadata.json': JSON.stringify(GreenProject.metadata(dir), null, 2) });
    return dir;
  }
}
