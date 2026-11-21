import { RuleContextOf } from '../testing/rule-context-of';
import type { LockedPackage } from '../types/locked-package.type';
import type { Lockfile } from '../types/lockfile.type';
import { BannedPackageRule } from './banned-package.rule';

const REASON = 'заменён другой библиотекой, возврат запрещён решением проекта';
const BANNED = [{ name: 'old-orm', reason: REASON }];

const pkg = (name: string, version: string, dependencies: string[] = [], line?: number): LockedPackage =>
  RuleContextOf.pkg(name, version, undefined, {
    ...(dependencies.length === 0 ? {} : { dependencies }),
    ...(line === undefined ? {} : { line }),
  });

const run = (lock: Lockfile, banned = BANNED, manifests = [RuleContextOf.manifest({})]) =>
  BannedPackageRule.run(RuleContextOf.make({ config: { bannedPackages: banned }, lock, manifests }));

describe('BannedPackageRule', () => {
  it('запрещённый пакет транзитивно — нарушение с цепочкой от прямой зависимости; разрешённое дерево чисто', () => {
    const packages = [
      pkg('kit', '1.0.0', ['orm-adapter@1.0.0']),
      pkg('orm-adapter', '1.0.0', ['old-orm@1.0.0']),
      pkg('old-orm', '1.0.0', [], 42),
    ];
    const lock = RuleContextOf.lock(packages, {
      importers: { '.': { kit: { field: 'devDependencies', specifier: '^1.0.0', target: 'kit@1.0.0' } } },
    });
    expect(run(lock)).toEqual({
      findings: [
        {
          rule: 'banned-package',
          verdict: 'violation',
          path: 'pnpm-lock.yaml',
          line: 42,
          subject: 'old-orm@1.0.0',
          reason: `запрещённый пакет в дереве (${REASON}); цепочки: package.json devDependencies.kit: kit@1.0.0 → orm-adapter@1.0.0 → old-orm@1.0.0`,
        },
      ],
      checked: 3,
    });
    const clean = RuleContextOf.lock([pkg('kit', '1.0.0')], {
      importers: { '.': { kit: { field: 'dependencies', specifier: '^1.0.0', target: 'kit@1.0.0' } } },
    });
    expect(run(clean)).toEqual({ findings: [], checked: 1 });
  });

  it('пустой перечень и перечень без ключа ничего не запрещают, даже если пакет в дереве', () => {
    const lock = RuleContextOf.lock([pkg('old-orm', '1.0.0')]);
    expect(run(lock, [])).toEqual({ findings: [], checked: 0 });
    expect(BannedPackageRule.run(RuleContextOf.make({ lock }))).toEqual({ findings: [], checked: 0 });
  });

  it('судится настоящее имя: алиас на запрещённый пакет — нарушение, алиас с именем запрещённого на другой — нет', () => {
    const aliased = RuleContextOf.lock([pkg('old-orm', '1.0.0')], {
      importers: {
        '.': { db: { field: 'dependencies', specifier: 'npm:old-orm@^1.0.0', target: 'old-orm@1.0.0' } },
      },
    });
    expect(run(aliased).findings.map((finding) => finding.reason)).toEqual([
      `запрещённый пакет в дереве (${REASON}); цепочки: package.json dependencies.db: old-orm@1.0.0`,
    ]);
    const disguised = RuleContextOf.lock([pkg('new-orm', '2.0.0')], {
      importers: {
        '.': {
          'old-orm': { field: 'dependencies', specifier: 'npm:new-orm@^2.0.0', target: 'new-orm@2.0.0' },
        },
      },
    });
    expect(run(disguised)).toEqual({ findings: [], checked: 1 });
  });

  it('каждая версия — своя находка; цепочки от КАЖДОЙ прямой зависимости, кратчайшие первыми, сверх пяти — числом', () => {
    const directs = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    const packages = [
      ...directs.map((name) => pkg(name, '1.0.0', ['mid@1.0.0'])),
      pkg('mid', '1.0.0', ['old-orm@1.0.0']),
      pkg('old-orm', '1.0.0'),
      pkg('old-orm', '2.0.0'),
    ];
    const lock = RuleContextOf.lock(packages, {
      importers: {
        '.': {
          ...Object.fromEntries(
            directs.map((name) => [
              name,
              { field: 'dependencies', specifier: '1.0.0', target: `${name}@1.0.0` },
            ]),
          ),
          'old-orm': { field: 'dependencies', specifier: '2.0.0', target: 'old-orm@2.0.0' },
        },
        'packages/app': { mid: { field: 'dependencies', specifier: '1.0.0', target: 'mid@1.0.0' } },
      },
    });
    const findings = run(lock).findings;
    expect(findings.map((finding) => [finding.subject, finding.reason])).toEqual([
      [
        'old-orm@1.0.0',
        `запрещённый пакет в дереве (${REASON}); цепочки: packages/app/package.json dependencies.mid: mid@1.0.0 → old-orm@1.0.0; package.json dependencies.a1: a1@1.0.0 → mid@1.0.0 → old-orm@1.0.0; package.json dependencies.a2: a2@1.0.0 → mid@1.0.0 → old-orm@1.0.0; package.json dependencies.a3: a3@1.0.0 → mid@1.0.0 → old-orm@1.0.0; package.json dependencies.a4: a4@1.0.0 → mid@1.0.0 → old-orm@1.0.0; и ещё 2`,
      ],
      [
        'old-orm@2.0.0',
        `запрещённый пакет в дереве (${REASON}); цепочки: package.json dependencies.old-orm: old-orm@2.0.0`,
      ],
    ]);
  });

  it('пакет без владельца (ни одна прямая зависимость к нему не ведёт) — всё равно нарушение, с объяснением', () => {
    const lock = RuleContextOf.lock([pkg('old-orm', '1.0.0')]);
    expect(run(lock).findings.map((finding) => [finding.verdict, finding.reason])).toEqual([
      [
        'violation',
        `запрещённый пакет в дереве (${REASON}); ни одна прямая зависимость к нему по записям lock-файла не ведёт — запись без владельца, пакет всё равно ставится`,
      ],
    ]);
  });

  it('цикл в дереве не зацикливает поиск цепочки', () => {
    const lock = RuleContextOf.lock(
      [
        pkg('a', '1.0.0', ['b@1.0.0']),
        pkg('b', '1.0.0', ['a@1.0.0', 'old-orm@1.0.0']),
        pkg('old-orm', '1.0.0'),
      ],
      { importers: { '.': { a: { field: 'dependencies', specifier: '1.0.0', target: 'a@1.0.0' } } } },
    );
    expect(run(lock).findings.map((finding) => finding.reason)).toEqual([
      `запрещённый пакет в дереве (${REASON}); цепочки: package.json dependencies.a: a@1.0.0 → b@1.0.0 → old-orm@1.0.0`,
    ]);
  });

  it('yarn 1 (прямых зависимостей в lock-файле нет): начала — package.json проектов по селектору записи', () => {
    const lock: Lockfile = {
      kind: 'yarn',
      path: 'yarn.lock',
      packages: [
        { ...pkg('kit', '1.0.0', ['old-orm@^1.0.0']), key: 'kit@^1.0.0, kit@^1.0.1' },
        { ...pkg('old-orm', '1.0.0'), key: 'old-orm@^1.0.0' },
      ],
    };
    const manifests = [RuleContextOf.manifest({ dependencies: { kit: '^1.0.1' } })];
    expect(run(lock, BANNED, manifests).findings.map((finding) => finding.reason)).toEqual([
      `запрещённый пакет в дереве (${REASON}); цепочки: package.json dependencies.kit: kit@1.0.0 → old-orm@1.0.0`,
    ]);
  });

  it('yarn 2+ (поля прямых зависимостей слиты): поле цепочки — из package.json проекта', () => {
    const lock = RuleContextOf.lock([pkg('old-orm', '1.0.0')], {
      kind: 'yarn-berry',
      directFieldsMerged: true,
      importers: {
        '.': { 'old-orm': { field: 'dependencies', specifier: 'npm:^1.0.0', target: 'old-orm@1.0.0' } },
      },
    });
    const manifests = [RuleContextOf.manifest({ devDependencies: { 'old-orm': '^1.0.0' } })];
    expect(run(lock, BANNED, manifests).findings.map((finding) => finding.reason)).toEqual([
      `запрещённый пакет в дереве (${REASON}); цепочки: package.json devDependencies.old-orm: old-orm@1.0.0`,
    ]);
  });

  it('config-зависимость pnpm — тоже начало цепочки', () => {
    const lock = RuleContextOf.lock([pkg('old-orm', '1.0.0')], {
      configDependencies: { 'old-orm': { specifier: '1.0.0', version: '1.0.0', target: 'old-orm@1.0.0' } },
    });
    expect(run(lock).findings.map((finding) => finding.reason)).toEqual([
      `запрещённый пакет в дереве (${REASON}); цепочки: package.json configDependencies.old-orm: old-orm@1.0.0`,
    ]);
  });
});
