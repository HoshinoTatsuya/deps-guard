import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { PackageMetadata } from '../types/package-metadata.type';

/**
 * Кэш метаданных реестра в репозитории: `{ "<имя>": { "time": { "<версия>":
 * "<ISO>" }, "versions": { "<версия>": { "hasInstallScript": true } } } }` —
 * подмножество документа реестра npm. Его пишет `deps-guard metadata`, а
 * гейт читает без сети: проверка в CI воспроизводима и не зависит от реестра.
 */
export class MetadataCache {
  public static read(root: string, file: string): Map<string, PackageMetadata> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolve(root, file), 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`кэш метаданных ${file} не прочитан: ${(error as Error).message}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`кэш метаданных ${file}: ожидался объект «имя → метаданные»`);
    }
    return MetadataCache.fromObject(parsed as Record<string, unknown>, file);
  }

  public static fromObject(value: Record<string, unknown>, label: string): Map<string, PackageMetadata> {
    const result = new Map<string, PackageMetadata>();
    for (const [name, entry] of Object.entries(value)) {
      const body = entry as { time?: unknown; versions?: unknown } | null;
      const valid =
        typeof body === 'object' &&
        body !== null &&
        (body.time === undefined || MetadataCache.isRecord(body.time)) &&
        (body.versions === undefined || MetadataCache.isRecord(body.versions));
      if (!valid) {
        throw new Error(`кэш метаданных ${label}: запись «${name}» — ожидались объекты time и versions`);
      }
      result.set(name, body as PackageMetadata);
    }
    return result;
  }

  private static isRecord(value: unknown): boolean {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
