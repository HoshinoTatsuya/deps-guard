import { PnpmWorkspace } from '../project/pnpm-workspace';
import { SpecifierKind } from '../project/specifier-kind';
import { RuleContextOf } from '../testing/rule-context-of';
import { FloatingRangeRule } from './floating-range.rule';

const REASON = 'пакет выпускает исправления часто, точная версия устаревает';

describe('SpecifierKind', () => {
  it.each([
    ['1.2.3', 'exact'],
    ['=1.2.3', 'exact'],
    ['v1.2.3', 'exact'],
    ['1.2.3-rc.1+build.5', 'exact'],
    ['^1.2.3', 'caret'],
    ['~1.2.3', 'tilde'],
    ['1.x', 'x-range'],
    ['1.2.*', 'x-range'],
    ['1', 'x-range'],
    ['*', 'any'],
    ['', 'any'],
    ['x', 'any'],
    ['latest', 'tag'],
    ['next', 'tag'],
    ['>=1.0.0', 'comparator'],
    ['>=1 <2', 'comparator'],
    ['1.0.0 - 2.0.0', 'comparator'],
    ['^1 || ^2', 'comparator'],
    ['npm:other@^1.0.0', 'caret'],
    ['npm:other@1.0.0', 'exact'],
    ['npm:@s/other@~1.0.0', 'tilde'],
    ['npm:other', 'tag'],
    ['npm:', 'unknown'],
    ['npm:other@npm:x@1', 'unknown'],
    ['jsr:@std/path@^1.0.0', 'caret'],
    ['jsr:1.0.0', 'exact'],
    ['jsr:@std/path', 'tag'],
    ['/abs/path', 'protocol'],
    ['~/vendor/x', 'protocol'],
    ['./vendor/x', 'protocol'],
    ['C:\\vendor\\x', 'protocol'],
    ['HTTPS://h/x.tgz', 'protocol'],
    ['workspace:*', 'protocol'],
    ['file:../x', 'protocol'],
    ['git+https://h/x.git#v1', 'protocol'],
    ['user/repo#main', 'protocol'],
    ['https://h/x.tgz', 'protocol'],
    ['1.2.3.4', 'unknown'],
    // Тот же разбор, что у источника: git в любой записи — не диапазон, а не «не разобран».
    ['ssh://git@h.example/r.git#main', 'protocol'],
    ['git@h.example:u/r.git', 'protocol'],
    ['gist:abc', 'protocol'],
    ['ftp://h/x.tgz', 'protocol'],
    ['NPM:other@^1.0.0', 'caret'],
    ['JSR:@std/path@1.0.0', 'exact'],
    ['CATALOG:', 'protocol'],
    ['npm:^1.0.0', 'caret'],
    ['npm:1.0.0', 'exact'],
  ])('%s — %s', (spec, kind) => {
    expect(SpecifierKind.of(spec)).toBe(kind);
  });
});

describe('FloatingRangeRule', () => {
  const manifest = RuleContextOf.manifest({
    dependencies: { exact: '1.0.0', caret: '^1.0.0', ws: 'workspace:*', odd: '1.2.3.4' },
    devDependencies: { tilde: '~2.0.0', tag: 'latest', allowed: '^3.0.0' },
  });

  it('по умолчанию запрещены все виды во всех полях; допуск снимает; неразобранный — всегда; лишний допуск — устарело', () => {
    const outcome = FloatingRangeRule.run(
      RuleContextOf.make({
        manifests: [manifest],
        config: { floatingRanges: { allow: { allowed: REASON, odd: REASON, exact: REASON } } },
      }),
    );
    expect(outcome.findings.map((finding) => [finding.verdict, finding.subject, finding.line])).toEqual([
      ['violation', 'caret', 4],
      ['violation', 'odd', 6],
      ['violation', 'tilde', 9],
      ['violation', 'tag', 10],
      ['stale', 'floatingRanges.allow["exact"]', undefined],
    ]);
    expect(outcome.checked).toBe(7);
  });

  it('настройка: только devDependencies и только tag', () => {
    const outcome = FloatingRangeRule.run(
      RuleContextOf.make({
        manifests: [manifest],
        config: { floatingRanges: { fields: ['devDependencies'], forbid: ['tag'] } },
      }),
    );
    expect(outcome.findings.map((finding) => finding.subject)).toEqual(['tag']);
  });

  it('catalog: — диапазон из каталога pnpm-workspace.yaml; записи нет — не разобран', () => {
    const workspace = PnpmWorkspace.parse(
      'catalog:\n  pinned: 1.2.3\n  loose: ^1.0.0\ncatalogs:\n  legacy:\n    old: ~0.9.0\n  default:\n    viaDefault: 2.0.0\n',
    );
    const outcome = FloatingRangeRule.run(
      RuleContextOf.make({
        pnpmWorkspace: workspace,
        manifests: [
          RuleContextOf.manifest({
            dependencies: {
              pinned: 'catalog:',
              loose: 'catalog:default',
              old: 'catalog:legacy',
              viaDefault: 'catalog:',
              missing: 'catalog:',
              constructor: 'catalog:',
            },
          }),
        ],
      }),
    );
    expect(outcome.findings.map((finding) => [finding.subject, finding.reason])).toEqual([
      ['loose', expect.stringContaining('catalog: «^1.0.0»')],
      ['old', expect.stringContaining('catalogs.legacy: «~0.9.0»')],
      ['missing', expect.stringContaining('не разобран')],
      ['constructor', expect.stringContaining('не разобран')],
    ]);
  });
});
