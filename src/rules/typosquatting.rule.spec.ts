import { EditDistance } from '../names/edit-distance';
import { PopularPackages } from '../names/popular-packages';
import { SimilarName } from '../names/similar-name';
import { RuleContextOf } from '../testing/rule-context-of';
import { TempDir } from '../testing/temp-dir';
import { TyposquattingRule } from './typosquatting.rule';

const REASON = 'законный пакет команды, имя совпало с популярным случайно';
const POPULAR = PopularPackages.load(PopularPackages.BUILTIN);

describe('EditDistance', () => {
  it.each([
    ['lodash', 'lodash', 0],
    ['lodash', 'lodahs', 1],
    ['lodash', 'lodas', 1],
    ['lodash', 'lodashh', 1],
    ['express', 'exprss', 1],
    ['react', 'preact', 1],
    ['abc', 'xyz', 3],
  ])('%s ↔ %s = %d', (a, b, expected) => {
    expect(EditDistance.between(a, b, 5)).toBe(expected);
  });

  it('ранний выход: больше предела — предел + 1', () => {
    expect(EditDistance.between('aaaaaaaa', 'bbbbbbbb', 2)).toBe(3);
    expect(EditDistance.between('a', 'abcdef', 2)).toBe(3);
  });
});

describe('SimilarName', () => {
  const similar = new SimilarName(POPULAR);

  it.each([
    ['lodahs', 'расстояние правки 1 до «lodash»'],
    ['expresss', 'расстояние правки 1 до «express»'],
    ['cross_env', 'смешение разделителей или регистра с «cross-env»'],
    ['Lodash', 'смешение разделителей или регистра с «lodash»'],
    ['crossenv', 'смешение разделителей или регистра с «cross-env»'],
    ['env-cross', 'перестановка частей имени «cross-env»'],
    ['@babell/preset-env', 'подмена scope: «@babel/preset-env»'],
    ['@types-x/node', 'подмена scope: «@types/node»'],
    ['@typess/node', 'подмена scope: «@types/node»'],
    ['@babell/anything', 'scope похож на популярный «@babel»'],
    ['webpack-cIi', 'расстояние правки 1 до «webpack-cli»'],
  ])('%s — %s', (name, reason) => {
    expect(similar.reasons(name)).toContain(reason);
  });

  it.each([
    'lodash',
    '@types/node',
    'left-pad',
    'ms',
    'mz',
    'qs',
    'my-company-utils',
    '@acme/core',
    'pg-types',
    'node-types',
    '@types/nodee',
    // Перестановка внутри популярного scope — не подмена: в @babel публикует только Babel.
    '@babel/env-preset',
    '@aws-sdk/client-ses',
    '@angular-devkit/schematics-cli',
    'safer-buffer',
    'through',
    'trough',
  ])('%s — не похоже (популярное само, короткое, далёкое или внутри популярного scope)', (name) => {
    expect(similar.reasons(name)).toEqual([]);
  });

  it('встроенный список не выродился', () => {
    expect(POPULAR.length).toBeGreaterThan(300);
    expect(new Set(POPULAR).size).toBe(POPULAR.length);
  });
});

describe('TyposquattingRule', () => {
  it('похожее имя в дереве и в прямых зависимостях — нарушение с местом; допуск снимает; лишний допуск — устарело', () => {
    const outcome = TyposquattingRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock([
          RuleContextOf.pkg('lodash', '4.17.21'),
          RuleContextOf.pkg('lodahs', '1.0.0', undefined, { line: 7 }),
        ]),
        manifests: [RuleContextOf.manifest({ dependencies: { expresss: '1.0.0', crossenv: '1.0.0' } })],
        config: { typosquatting: { allow: { crossenv: REASON, chalk: REASON } } },
      }),
    );
    expect(
      outcome.findings.map((finding) => [finding.verdict, finding.subject, finding.path, finding.line]),
    ).toEqual([
      ['violation', 'expresss', 'package.json', 3],
      ['violation', 'lodahs', 'pnpm-lock.yaml', 7],
      ['stale', 'typosquatting.allow["chalk"]', 'deps-guard.json', undefined],
    ]);
    expect(outcome.checked).toBe(4);
  });

  it('свой список: пустой или битый — не прочитано (проверка против пустого списка зелёная всегда)', () => {
    const dir = TempDir.create({ 'popular.json': JSON.stringify({ names: [] }) });
    try {
      const outcome = TyposquattingRule.run(
        RuleContextOf.make({
          popular: () => PopularPackages.load(`${dir}/popular.json`),
          config: { typosquatting: { popularFile: 'popular.json' } },
        }),
      );
      expect(outcome.findings.map((finding) => finding.verdict)).toEqual(['broken']);
    } finally {
      TempDir.remove(dir);
    }
  });
});

describe('TyposquattingRule: npm:-алиас', () => {
  it('судится цель алиаса, а не ключ', () => {
    const outcome = TyposquattingRule.run(
      RuleContextOf.make({
        manifests: [
          RuleContextOf.manifest({ dependencies: { lodash: 'npm:lodahs@1.0.0', lodahs2: 'npm:lodash@4' } }),
        ],
      }),
    );
    expect(outcome.findings.map((finding) => finding.subject)).toEqual(['lodahs']);
  });
});
