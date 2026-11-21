import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Список популярных пакетов для проверки похожих имён. Встроенный —
 * `data/popular-packages.json` пакета; свой — `typosquatting.popularFile`
 * проекта (тот же формат `{ "names": [...] }`). Пустой или битый список —
 * отказ: проверка против пустого списка зелёная всегда.
 */
export class PopularPackages {
  public static readonly BUILTIN = join(__dirname, '..', '..', 'data', 'popular-packages.json');

  public static load(path: string): string[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      throw new Error(`список популярных пакетов ${path} не прочитан: ${(error as Error).message}`);
    }
    const names = (parsed as { names?: unknown } | null)?.names;
    if (
      !Array.isArray(names) ||
      names.length === 0 ||
      names.some((name) => typeof name !== 'string' || name === '')
    ) {
      throw new Error(`список популярных пакетов ${path}: ожидалось { "names": [непустые имена] }`);
    }
    return names as string[];
  }
}
