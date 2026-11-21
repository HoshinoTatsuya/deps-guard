import { GitShow } from '../project/git-show';
import { PnpmWorkspace } from '../project/pnpm-workspace';
import { GitRepo } from '../testing/git-repo';
import { RuleContextOf } from '../testing/rule-context-of';
import { TempDir } from '../testing/temp-dir';
import { NewDependencyRule } from './new-dependency.rule';

const REASON = 'нужна для разбора дат в отчётах, замена самописного кода';

describe('NewDependencyRule', () => {
  let dir: string;

  beforeEach(() => {
    dir = TempDir.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  it('файл базовой линии: новая без допуска — нарушение, с допуском — нет; допуск удалённой — устарело; короткая причина — не допуск', () => {
    TempDir.write(dir, { 'deps-guard.baseline.json': JSON.stringify({ dependencies: ['a'] }) });
    const context = RuleContextOf.make({
      root: dir,
      config: {
        newDependencies: {
          baseline: { file: 'deps-guard.baseline.json' },
          allow: { c: REASON, gone: REASON, d: 'нужно' },
        },
      },
      manifests: [
        RuleContextOf.manifest({
          dependencies: { a: '1.0.0', b: '1.0.0' },
          devDependencies: { c: '1.0.0', d: '1.0.0' },
        }),
      ],
    });
    const outcome = NewDependencyRule.run(context);
    expect(
      outcome.findings.map((finding) => [finding.verdict, finding.subject, finding.path, finding.line]),
    ).toEqual([
      ['violation', 'b', 'package.json', 4],
      ['violation', 'd', 'package.json', 8],
      ['stale', 'newDependencies.allow["gone"]', 'deps-guard.json', undefined],
      ['violation', 'newDependencies.allow["d"]', 'deps-guard.json', undefined],
    ]);
    expect(outcome.checked).toBe(4);
  });

  it('git-ревизия: база из коммита, новый проект workspace — все его зависимости новые', () => {
    GitRepo.init(dir);
    TempDir.write(dir, { 'package.json': JSON.stringify({ dependencies: { a: '1.0.0' } }) });
    const base = GitRepo.commitAll(dir, 'база');
    const context = RuleContextOf.make({
      root: dir,
      config: { newDependencies: { baseline: { gitRef: 'не-используется' } } },
      baseRef: base,
      gitShow: GitShow.reader(dir),
      gitList: GitShow.lister(dir),
      manifests: [
        RuleContextOf.manifest({ dependencies: { a: '1.0.0', b: '2.0.0' } }),
        RuleContextOf.manifest({ dependencies: { a: '1.0.0', x: '3.0.0' } }, 'packages/x'),
      ],
    });
    const outcome = NewDependencyRule.run(context);
    expect(outcome.findings.map((finding) => [finding.verdict, finding.subject, finding.path])).toEqual([
      ['violation', 'b', 'package.json'],
      ['violation', 'x', 'packages/x/package.json'],
    ]);
  });

  it('зависимость, перенесённая между проектами workspace, новой не считается', () => {
    GitRepo.init(dir);
    TempDir.write(dir, { 'package.json': JSON.stringify({ dependencies: { moved: '1.0.0' } }) });
    const base = GitRepo.commitAll(dir, 'база');
    const outcome = NewDependencyRule.run(
      RuleContextOf.make({
        root: dir,
        baseRef: base,
        gitShow: GitShow.reader(dir),
        gitList: GitShow.lister(dir),
        manifests: [
          RuleContextOf.manifest({}),
          RuleContextOf.manifest({ dependencies: { moved: '1.0.0' } }, 'packages/y'),
        ],
      }),
    );
    expect(outcome.findings).toEqual([]);
  });

  it('npm:-алиас: новая — цель, а не ключ; алиас базы считается целью', () => {
    TempDir.write(dir, {
      'deps-guard.baseline.json': JSON.stringify({ dependencies: ['aa-lib', 'lodash'] }),
    });
    const outcome = NewDependencyRule.run(
      RuleContextOf.make({
        root: dir,
        config: { newDependencies: { baseline: { file: 'deps-guard.baseline.json' } } },
        manifests: [
          RuleContextOf.manifest({
            dependencies: { 'aa-lib': 'npm:bb-lib@1.0.0', 'my-lodash': 'npm:lodash@4.17.21' },
          }),
        ],
      }),
    );
    expect(outcome.findings.map((finding) => [finding.subject, finding.reason])).toEqual([
      ['bb-lib', expect.stringContaining('aa-lib → npm:bb-lib@1.0.0')],
    ]);
    GitRepo.init(dir);
    TempDir.write(dir, { 'package.json': JSON.stringify({ dependencies: { old: 'npm:bb-lib@1.0.0' } }) });
    const base = GitRepo.commitAll(dir, 'база');
    const fromGit = NewDependencyRule.run(
      RuleContextOf.make({
        root: dir,
        baseRef: base,
        gitShow: GitShow.reader(dir),
        gitList: GitShow.lister(dir),
        manifests: [
          RuleContextOf.manifest({ dependencies: { renamed: 'npm:bb-lib@1.0.0', fresh: '1.0.0' } }),
        ],
      }),
    );
    expect(fromGit.findings.map((finding) => finding.subject)).toEqual(['fresh']);
  });

  it('config-зависимости pnpm: новая — нарушение с местом в pnpm-workspace.yaml; из базы — нет', () => {
    GitRepo.init(dir);
    TempDir.write(dir, {
      'package.json': '{}',
      'pnpm-workspace.yaml': "configDependencies:\n  kept: '1.0.0+sha512-a'\n",
    });
    const base = GitRepo.commitAll(dir, 'база');
    const workspace = PnpmWorkspace.parse(
      "allowBuilds: {}\nconfigDependencies:\n  kept: '1.0.0+sha512-a'\n  added: '2.0.0+sha512-b'\n",
    );
    const outcome = NewDependencyRule.run(
      RuleContextOf.make({
        root: dir,
        baseRef: base,
        gitShow: GitShow.reader(dir),
        gitList: GitShow.lister(dir),
        pnpmWorkspace: workspace,
      }),
    );
    expect(outcome.findings.map((finding) => [finding.subject, finding.path, finding.line])).toEqual([
      ['added', 'pnpm-workspace.yaml', 4],
    ]);
    expect(outcome.checked).toBe(2);
    const npm = NewDependencyRule.run(
      RuleContextOf.make({
        root: dir,
        baseRef: base,
        gitShow: GitShow.reader(dir),
        gitList: GitShow.lister(dir),
        pnpmWorkspace: workspace,
        lock: RuleContextOf.lock([], { kind: 'npm', path: 'package-lock.json' }),
      }),
    );
    expect(npm.findings).toEqual([]);
  });

  it('база — проекты lock-файла базы и шаблоны её workspace, а не пути текущих package.json', () => {
    GitRepo.init(dir);
    TempDir.write(dir, {
      'package.json': JSON.stringify({ workspaces: ['libs/*'] }),
      'libs/gone/package.json': JSON.stringify({ dependencies: { fromGlob: '1.0.0' } }),
      // Проект lock-файла npm — каталог под шаблонами workspaces его корневой записи
      // (здесь они разошлись с package.json: lock записан при прежних шаблонах).
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: { '': { workspaces: ['tools/*'] }, 'tools/x': {} },
      }),
      'tools/x/package.json': JSON.stringify({ dependencies: { fromLock: '1.0.0' } }),
    });
    const base = GitRepo.commitAll(dir, 'база');
    const outcome = NewDependencyRule.run(
      RuleContextOf.make({
        root: dir,
        baseRef: base,
        gitShow: GitShow.reader(dir),
        gitList: GitShow.lister(dir),
        lock: RuleContextOf.lock([], { kind: 'npm', path: 'package-lock.json' }),
        manifests: [
          RuleContextOf.manifest({ dependencies: { fromGlob: '1.0.0', fromLock: '1.0.0', fresh: '1.0.0' } }),
        ],
      }),
    );
    expect(outcome.findings.map((finding) => finding.subject)).toEqual(['fresh']);
  });

  it('несуществующая ревизия — не прочитано; нет базы — не проверено (не зелёный)', () => {
    GitRepo.init(dir);
    TempDir.write(dir, { 'package.json': '{}' });
    GitRepo.commitAll(dir, 'база');
    const broken = NewDependencyRule.run(
      RuleContextOf.make({ root: dir, baseRef: 'origin/нет-такой', gitShow: GitShow.reader(dir) }),
    );
    expect(broken.findings.map((finding) => [finding.verdict, finding.reason])).toEqual([
      ['broken', expect.stringContaining('не найдена')],
    ]);
    const none = NewDependencyRule.run(
      RuleContextOf.make({ manifests: [RuleContextOf.manifest({ dependencies: { a: '1' } })] }),
    );
    expect(none.findings.map((finding) => finding.verdict)).toEqual(['unverified']);
  });

  it('битый файл базовой линии — не прочитано', () => {
    TempDir.write(dir, { 'base.json': '{"dependencies": "a"}' });
    const outcome = NewDependencyRule.run(
      RuleContextOf.make({ root: dir, config: { newDependencies: { baseline: { file: 'base.json' } } } }),
    );
    expect(outcome.findings.map((finding) => finding.verdict)).toEqual(['broken']);
  });

  describe('смена источника под старым ключом — новая зависимость `имя@источник`', () => {
    const run = (dependencies: Record<string, string>, allow: Record<string, string> = {}) => {
      TempDir.write(dir, {
        'deps-guard.baseline.json': JSON.stringify({
          dependencies: ['aa-lib', 'gitdep@git+https://git.example/u/gitdep.git', 'local@file:vendor/local'],
        }),
      });
      return NewDependencyRule.run(
        RuleContextOf.make({
          root: dir,
          config: { newDependencies: { baseline: { file: 'deps-guard.baseline.json' }, allow } },
          manifests: [RuleContextOf.manifest({ dependencies })],
        }),
      ).findings.map((finding) => [finding.verdict, finding.subject]);
    };

    it.each([
      ['реестр → архив чужого пакета по адресу', 'http://127.0.0.1:48701/bb-lib/-/bb-lib-1.0.0.tgz'],
      ['реестр → git', 'git+https://evil.example/u/aa-lib.git#0123456789abcdef0123456789abcdef01234567'],
      ['реестр → сокращение GitHub', 'evil/aa-lib'],
      ['реестр → git@хост:', 'git@evil.example:u/aa-lib.git'],
      ['реестр → каталог', 'file:./evil'],
      ['реестр → путь', '../evil'],
      ['реестр → алиас в верхнем регистре', 'NPM:bb-lib@1.0.0'],
    ])('%s', (_name, specifier) => {
      const findings = run({ 'aa-lib': specifier });
      expect(findings).toHaveLength(1);
      expect(findings[0]?.[0]).toBe('violation');
      expect(findings[0]?.[1]).not.toBe('aa-lib');
    });

    it('законные двойники: диапазон реестра, смена коммита git, тот же каталог другой записью — не новые', () => {
      expect(
        run({
          'aa-lib': '^1.0.0',
          gitdep: 'git+https://git.example/u/gitdep.git#fedcba9876543210fedcba9876543210fedcba98',
          local: 'file:vendor/./local',
        }),
      ).toEqual([]);
    });

    it('предмет и допуск — `имя@источник`: допуск по одному имени смену источника не пропускает', () => {
      const url = 'http://127.0.0.1:48701/bb-lib/-/bb-lib-1.0.0.tgz';
      expect(run({ 'aa-lib': url })).toEqual([['violation', `aa-lib@${url}`]]);
      expect(run({ 'aa-lib': url }, { [`aa-lib@${url}`]: REASON })).toEqual([]);
      expect(run({ 'aa-lib': url }, { 'aa-lib': REASON })).toEqual([
        ['violation', `aa-lib@${url}`],
        ['stale', 'newDependencies.allow["aa-lib"]'],
      ]);
      expect(run({ gitdep: 'git+https://other.example/u/gitdep.git' })).toEqual([
        ['violation', 'gitdep@git+https://other.example/u/gitdep.git'],
      ]);
      expect(run({ 'aa-lib': 'evil/aa-lib#main' })).toEqual([['violation', 'aa-lib@github:evil/aa-lib']]);
    });
  });
});
