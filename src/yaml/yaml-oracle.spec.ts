import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { loadAll } from 'js-yaml';

import { TempDir } from '../testing/temp-dir';
import { YamlSubset } from './yaml-subset';

/**
 * Разборщик гейта против ОБОИХ разборщиков менеджеров: js-yaml (pnpm до 11) —
 * вживую, pnpm 12 (свой разборщик, читает скаляр по типу поля) — по записи
 * `scripts/record-pnpm12-yaml.cjs` (`pnpm config list` на каждом входе, без
 * сети и с изолированным HOME). Всё, что гейт принял, обязано читаться так же,
 * как у каждого менеджера, который вход принял; вход, который менеджеры
 * читают по-разному, гейт обязан отвергнуть.
 */
interface OracleCase {
  readonly text: string;
  /** Настройки, которые pnpm 12 прочёл из файла; `null` — pnpm 12 отказал. */
  readonly pnpm12: Record<string, unknown> | null;
}

const oracle = JSON.parse(readFileSync(join(TempDir.FIXTURES, 'yaml-oracle', 'pnpm12.json'), 'utf8')) as {
  pnpm: string;
  cases: OracleCase[];
};

const normalize = (value: unknown): unknown => {
  if (typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

const attempt = (read: () => unknown): { value: unknown } | undefined => {
  try {
    return { value: read() };
  } catch {
    return undefined;
  }
};

const gate = (text: string) => attempt(() => normalize(YamlSubset.parse(text).value));
const jsYaml = (text: string) =>
  attempt(() => normalize(loadAll(text).filter((value) => value !== null && value !== undefined)[0] ?? null));

describe('YamlSubset против js-yaml и pnpm 12', () => {
  it('запись сделана pnpm 12, выборка не выродилась: есть принятые, отвергнутые и отказы pnpm 12', () => {
    expect(oracle.pnpm).toMatch(/^12\./);
    const accepted = oracle.cases.filter((entry) => gate(entry.text) !== undefined);
    expect(accepted.length).toBeGreaterThanOrEqual(20);
    expect(oracle.cases.length - accepted.length).toBeGreaterThanOrEqual(20);
    expect(oracle.cases.filter((entry) => entry.pnpm12 === null).length).toBeGreaterThanOrEqual(8);
  });

  it.each(oracle.cases.map((entry) => [JSON.stringify(entry.text), entry] as const))(
    '%s: принятое гейтом читается как у каждого принявшего менеджера',
    (_name, entry) => {
      const mine = gate(entry.text);
      if (mine === undefined) {
        return;
      }
      const js = jsYaml(entry.text);
      if (js !== undefined) {
        expect(mine.value).toEqual(js.value);
      }
      if (entry.pnpm12 !== null) {
        const read = (mine.value ?? {}) as Record<string, unknown>;
        for (const [key, value] of Object.entries(entry.pnpm12)) {
          expect({ key, value: read[key] }).toEqual({ key, value: normalize(value) });
        }
      }
    },
  );

  it('вход, который js-yaml и pnpm 12 оба читают, но по-разному, гейт отвергает', () => {
    const conflicting = oracle.cases.filter((entry) => {
      const js = jsYaml(entry.text);
      if (js === undefined || entry.pnpm12 === null) {
        return false;
      }
      const read = (js.value ?? {}) as Record<string, unknown>;
      return Object.entries(entry.pnpm12).some(
        ([key, value]) => JSON.stringify(read[key]) !== JSON.stringify(normalize(value)),
      );
    });
    expect(conflicting.length).toBeGreaterThanOrEqual(5);
    expect(conflicting.filter((entry) => gate(entry.text) !== undefined).map((entry) => entry.text)).toEqual(
      [],
    );
  });
});
