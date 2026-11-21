import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ParsePnpmLock } from '../lockfile/parse-pnpm-lock';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import { RuleContextOf } from '../testing/rule-context-of';
import { TempDir } from '../testing/temp-dir';
import { LockMismatchRule } from './lock-mismatch.rule';

describe('LockMismatchRule', () => {
  const manifest = RuleContextOf.manifest({
    dependencies: { same: '1.0.0', changed: '^2.0.0', missing: '1.0.0' },
    devDependencies: { moved: '1.0.0' },
  });

  it('pnpm/npm: совпадающие — без находок; нет в lock, другой спецификатор, другое поле, лишняя в lock — нарушения', () => {
    const lock = RuleContextOf.lock([], {
      importers: {
        '.': {
          same: { field: 'dependencies', specifier: '1.0.0' },
          changed: { field: 'dependencies', specifier: '^1.0.0' },
          moved: { field: 'dependencies', specifier: '1.0.0' },
          extra: { field: 'dependencies', specifier: '1.0.0', line: 12 },
        },
      },
    });
    const outcome = LockMismatchRule.run(RuleContextOf.make({ manifests: [manifest], lock }));
    expect(
      outcome.findings.map((finding) => [finding.subject, finding.path, finding.reason.slice(0, 20)]),
    ).toEqual([
      ['changed', 'package.json', 'спецификатор расходи'],
      ['missing', 'package.json', 'dependencies: «1.0.0'],
      ['moved', 'package.json', 'поле расходится: pac'],
      ['extra', 'pnpm-lock.yaml', 'в pnpm-lock.yaml (пр'],
    ]);
    expect(outcome.checked).toBe(5);
  });

  it('согласованный проект — без находок', () => {
    const lock = RuleContextOf.lock([], {
      importers: { '.': { a: { field: 'devDependencies', specifier: '1.0.0' } } },
    });
    const outcome = LockMismatchRule.run(
      RuleContextOf.make({ manifests: [RuleContextOf.manifest({ devDependencies: { a: '1.0.0' } })], lock }),
    );
    expect(outcome).toEqual({ findings: [], checked: 1 });
  });

  it('проект workspace без записи в lock — его зависимости нарушения', () => {
    const outcome = LockMismatchRule.run(
      RuleContextOf.make({
        manifests: [
          RuleContextOf.manifest({}),
          RuleContextOf.manifest({ dependencies: { a: '1.0.0' } }, 'packages/p'),
        ],
        lock: RuleContextOf.lock([]),
      }),
    );
    expect(outcome.findings.map((finding) => [finding.subject, finding.path])).toEqual([
      ['packages/p', 'packages/p/package.json'],
      ['a', 'packages/p/package.json'],
    ]);
  });

  it('проект workspace без зависимостей и без записи в lock — тоже нарушение (lock-файл его не знает)', () => {
    const outcome = LockMismatchRule.run(
      RuleContextOf.make({
        manifests: [RuleContextOf.manifest({}), RuleContextOf.manifest({}, 'packages/empty')],
        lock: RuleContextOf.lock([]),
      }),
    );
    expect(outcome.findings.map((finding) => finding.subject)).toEqual(['packages/empty']);
  });

  it('спецификатор из overrides lock-файла — согласовано; чужой спецификатор при overrides — нет', () => {
    const run = (overrides: Record<string, string>): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          manifests: [RuleContextOf.manifest({ dependencies: { loc: 'file:./local', b: '^1.0.0' } })],
          lock: RuleContextOf.lock([], {
            overrides,
            importers: {
              '.': {
                loc: { field: 'dependencies', specifier: 'file:local2' },
                b: { field: 'dependencies', specifier: '1.0.1' },
              },
            },
          }),
        }),
      ).findings.map((finding) => finding.subject);
    expect(run({ loc: 'file:./local2', 'b@^1': '1.0.1' })).toEqual([]);
    expect(run({})).toEqual(['loc', 'b']);
    expect(run({ loc: 'file:./other', 'x>b': '1.0.1', 'bb@^1': '1.0.1' })).toEqual(['loc', 'b']);
  });

  it('excludeLinksFromLockfile: link: без записи в lock — согласовано; без флага — нарушение', () => {
    const run = (linksOmitted: boolean): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          manifests: [RuleContextOf.manifest({ dependencies: { l: 'link:./l', r: '1.0.0' } })],
          lock: RuleContextOf.lock([], { linksOmitted, importers: { '.': {} } }),
        }),
      ).findings.map((finding) => finding.subject);
    expect(run(true)).toEqual(['r']);
    expect(run(false)).toEqual(['l', 'r']);
  });

  it('протоколы link:/file: — без учёта регистра: LINK: при excludeLinksFromLockfile и FILE: в overrides согласованы', () => {
    const run = (dependencies: Record<string, string>, extra: Record<string, unknown>): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          manifests: [RuleContextOf.manifest({ dependencies })],
          lock: RuleContextOf.lock([], { importers: { '.': {} }, ...extra }),
        }),
      ).findings.map((finding) => finding.subject);
    expect(run({ l: 'LINK:./l' }, { linksOmitted: true })).toEqual([]);
    const overridden = (lockSpecifier: string): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          manifests: [RuleContextOf.manifest({ dependencies: { loc: 'file:./other' } })],
          lock: RuleContextOf.lock([], {
            overrides: { loc: 'FILE:other' },
            importers: { '.': { loc: { field: 'dependencies', specifier: lockSpecifier } } },
          }),
        }),
      ).findings.map((finding) => finding.subject);
    expect(overridden('file:other')).toEqual([]);
    expect(overridden('link:other')).toEqual(['loc']);
  });

  it('зависимость в двух полях: lock-файл записал одно из них — согласовано; третье поле — нет', () => {
    const manifest2 = RuleContextOf.manifest({
      dependencies: { a: '1.0.0' },
      devDependencies: { a: '1.0.0' },
      optionalDependencies: { o: '2.0.0' },
    });
    const run = (field: 'dependencies' | 'devDependencies' | 'optionalDependencies'): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          manifests: [manifest2],
          lock: RuleContextOf.lock([], {
            importers: {
              '.': {
                a: { field, specifier: '1.0.0' },
                o: { field: 'optionalDependencies', specifier: '2.0.0' },
              },
            },
          }),
        }),
      ).findings.map((finding) => `${finding.subject}: ${finding.reason.slice(0, 15)}`);
    expect(run('dependencies')).toEqual([]);
    expect(run('devDependencies')).toEqual([]);
    expect(run('optionalDependencies')).toEqual(['a: поле расходится']);
  });

  it('висячая ссылка lock-файла — нарушение со строкой', () => {
    const outcome = LockMismatchRule.run(
      RuleContextOf.make({
        manifests: [RuleContextOf.manifest({ dependencies: { a: '1.0.0' } })],
        lock: RuleContextOf.lock([], {
          importers: { '.': { a: { field: 'dependencies', specifier: '1.0.0', version: '1.0.0' } } },
          dangling: [{ importer: '.', name: 'a', version: '1.0.0', line: 9 }],
        }),
      }),
    );
    expect(outcome.findings.map((finding) => [finding.subject, finding.path, finding.line])).toEqual([
      ['a', 'pnpm-lock.yaml', 9],
    ]);
    expect(outcome.checked).toBe(2);
  });

  it('имя зависимости — свойство Object.prototype: «нет в lock», а не ложное совпадение', () => {
    const outcome = LockMismatchRule.run(
      RuleContextOf.make({
        manifests: [RuleContextOf.manifest({ dependencies: { constructor: '1.0.0', toString: '1.0.0' } })],
        lock: RuleContextOf.lock([], { importers: { '.': {} } }),
      }),
    );
    expect(outcome.findings.map((finding) => finding.reason.slice(0, 30))).toEqual([
      'dependencies: «1.0.0» нет в pn',
      'dependencies: «1.0.0» нет в pn',
    ]);
  });

  it('yarn: сверка по селектору имя@спецификатор', () => {
    const lock = RuleContextOf.lock([], {
      kind: 'yarn',
      path: 'yarn.lock',
      selectors: new Set(['same@1.0.0', 'changed@^1.0.0', 'moved@1.0.0']),
    });
    const { importers: _ignored, ...withoutImporters } = lock;
    const outcome = LockMismatchRule.run(
      RuleContextOf.make({ manifests: [manifest], lock: withoutImporters }),
    );
    expect(outcome.findings.map((finding) => finding.subject)).toEqual(['changed', 'missing']);
  });

  it('yarn: зависимость на пакет workspace без записи в yarn.lock — согласовано', () => {
    const lock = RuleContextOf.lock([], { kind: 'yarn', path: 'yarn.lock', selectors: new Set() });
    const { importers: _ignored, ...withoutImporters } = lock;
    const outcome = LockMismatchRule.run(
      RuleContextOf.make({
        manifests: [
          RuleContextOf.manifest({ name: 'root', dependencies: { b: '1.0.0', other: '1.0.0' } }),
          RuleContextOf.manifest({ name: 'b', version: '1.0.0' }, 'packages/b'),
        ],
        lock: withoutImporters,
      }),
    );
    expect(outcome.findings.map((finding) => finding.subject)).toEqual(['other']);
  });

  it('config-зависимости pnpm-workspace.yaml и lock-файла: те же имена и версии', () => {
    const run = (workspace: string, locked: Record<string, { specifier: string }>): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          pnpmWorkspace: PnpmWorkspace.parse(workspace),
          lock: RuleContextOf.lock([], { configDependencies: locked }),
        }),
      ).findings.map((finding) => `${finding.subject}|${finding.path}|${finding.reason.slice(0, 18)}`);
    const workspace =
      "configDependencies:\n  same: '1.0.0+sha512-a'\n  bumped: '2.0.0+sha512-b'\n  absent: '1.0.0+sha512-c'\n";
    expect(
      run(workspace, {
        same: { specifier: '1.0.0' },
        bumped: { specifier: '1.0.0' },
        extra: { specifier: '1.0.0' },
      }),
    ).toEqual([
      'bumped|pnpm-workspace.yaml|config-зависимость',
      'absent|pnpm-workspace.yaml|configDependencies',
      'extra|pnpm-lock.yaml|config-зависимость',
    ]);
    expect(run("configDependencies:\n  same: '1.0.0+sha512-a'\n", { same: { specifier: '1.0.0' } })).toEqual(
      [],
    );
  });

  describe('yarn 2+', () => {
    const berry = (
      dependencies: Record<string, string>,
      devDependencies: Record<string, string>,
      locked: Record<string, string>,
      extra: Record<string, unknown> = {},
      rootExtra: Record<string, unknown> = {},
    ): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          manifests: [RuleContextOf.manifest({ dependencies, devDependencies, ...rootExtra })],
          lock: RuleContextOf.lock([], {
            kind: 'yarn-berry',
            path: 'yarn.lock',
            directFieldsMerged: true,
            importers: {
              '.': Object.fromEntries(
                Object.entries(locked).map(([name, specifier]) => [
                  name,
                  { field: 'dependencies', specifier },
                ]),
              ),
            },
            ...extra,
          }),
        }),
      ).findings.map((finding) => `${finding.subject}|${finding.reason.slice(0, 18)}`);

    it('диапазон в форме дескриптора (npm:) и поле не важны; другой диапазон — нарушение', () => {
      expect(
        berry(
          { a: '^1.0.0' },
          { b: '1.0.0', c: 'workspace:*' },
          { a: 'npm:^1.0.0', b: '1.0.0', c: 'workspace:*' },
        ),
      ).toEqual([]);
      expect(berry({ a: '^1.0.0' }, {}, { a: 'npm:^2.0.0' })).toEqual(['a|спецификатор расхо']);
      expect(berry({ a: 'file:./x' }, {}, { a: 'npm:file:./x' })).toEqual(['a|спецификатор расхо']);
    });

    it('висячая прямая зависимость, которую подменяют resolutions корня дескриптором из lock-файла, — согласована', () => {
      const dangling = [{ importer: '.', name: 'w', version: '^3.8.2' }];
      const patch = 'patch:w@npm%3A3.8.2#./.yarn/patches/w.patch';
      const selectors = new Set([`w@${patch}`]);
      expect(
        berry(
          { w: '^3.8.2' },
          {},
          { w: '^3.8.2' },
          { dangling, selectors },
          { resolutions: { 'w@^3.8.2': patch } },
        ),
      ).toEqual([]);
      expect(
        berry({ w: '^3.8.2' }, {}, { w: '^3.8.2' }, { dangling, selectors }, { resolutions: { w: patch } }),
      ).toEqual([]);
      expect(berry({ w: '^3.8.2' }, {}, { w: '^3.8.2' }, { dangling, selectors }, {})).toEqual([
        'w|проект .: прямая з',
      ]);
      expect(
        berry(
          { w: '^3.8.2' },
          {},
          { w: '^3.8.2' },
          { dangling, selectors },
          { resolutions: { w: 'patch:w@npm%3A9.9.9#x' } },
        ),
      ).toEqual(['w|проект .: прямая з']);
      expect(
        berry(
          { w: '^3.8.2' },
          {},
          { w: '^3.8.2' },
          { dangling, selectors, kind: 'npm' },
          { resolutions: { w: patch } },
        ),
      ).toEqual(['w|проект .: прямая з']);
    });
  });

  /**
   * pnpm 9.5+: диапазон каталога записан в lock-файле (`catalogs.<имя>.<пакет>.specifier`),
   * а проект ссылается на него `catalog:`. Каталог изменён в pnpm-workspace.yaml без
   * переустановки — `pnpm install --frozen-lockfile` отказывает
   * (ERR_PNPM_LOCKFILE_CONFIG_MISMATCH), а сверка `catalog:` с `catalog:` была зелёной.
   * Lock-файл — вывод pnpm 12.21.0.
   */
  describe('каталоги pnpm против catalogs lock-файла', () => {
    const dir = join(TempDir.FIXTURES, 'pnpm-catalog');
    const lock = ParsePnpmLock.parse(readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8'), 'pnpm-lock.yaml');
    const project = RuleContextOf.manifest(
      JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>,
    );
    const run = (workspace: string): string[] =>
      LockMismatchRule.run(
        RuleContextOf.make({
          manifests: [project],
          lock,
          catalogs: {
            settings: PnpmWorkspace.settings(PnpmWorkspace.parse(workspace)),
            file: 'pnpm-workspace.yaml',
          },
        }),
      ).findings.map((finding) => `${finding.subject}|${finding.reason}`);

    it('lock-файл записал диапазоны каталогов', () => {
      expect(lock.catalogs).toEqual({
        default: { 'is-number': { specifier: '7.0.0', line: expect.any(Number) } },
        tools: { ms: { specifier: '2.1.3', line: expect.any(Number) } },
      });
    });

    it('каталоги совпадают — без находок', () => {
      expect(run(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))).toEqual([]);
    });

    it('диапазон каталога изменён без переустановки — нарушение у каждого (catalog и catalogs.<имя>)', () => {
      expect(
        run('packages:\n  - .\ncatalog:\n  is-number: 7.0.1\ncatalogs:\n  tools:\n    ms: ^2.1.3\n'),
      ).toEqual([
        'is-number|каталог pnpm-workspace.yaml catalog: «7.0.1», в pnpm-lock.yaml catalogs.default «7.0.0»: lock-файл устарел',
        'ms|каталог pnpm-workspace.yaml catalogs.tools: «^2.1.3», в pnpm-lock.yaml catalogs.tools «2.1.3»: lock-файл устарел',
      ]);
    });

    it('записи каталога в lock-файле нет — нарушение', () => {
      const bare = { ...lock, catalogs: {} };
      expect(
        LockMismatchRule.run(
          RuleContextOf.make({
            manifests: [project],
            lock: bare,
            catalogs: {
              settings: PnpmWorkspace.settings(
                PnpmWorkspace.parse(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')),
              ),
              file: 'pnpm-workspace.yaml',
            },
          }),
        ).findings.map((finding) => finding.subject),
      ).toEqual(['is-number', 'ms']);
    });
  });
});
