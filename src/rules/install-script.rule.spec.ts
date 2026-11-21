import { PnpmWorkspace } from '../project/pnpm-workspace';
import { RuleContextOf } from '../testing/rule-context-of';
import { TempDir } from '../testing/temp-dir';
import type { RuleContext } from '../types/rule-context.type';
import { InstallScriptRule } from './install-script.rule';

const REASON = 'собирает нативный модуль, без него падает разбор изображений';

const scripted = (
  names: readonly string[],
): Map<string, { versions: Record<string, { hasInstallScript: boolean }> }> =>
  new Map(
    ['good', 'denied', 'undecided', 'versioned', 'own', 'clean'].map((name) => [
      name,
      { versions: { '1.0.0': { hasInstallScript: names.includes(name) } } },
    ]),
  );

const summary = (context: RuleContext): Array<[string, string]> =>
  InstallScriptRule.run(context).findings.map((finding) => [finding.verdict, finding.subject]);

describe('InstallScriptRule', () => {
  let dir: string;

  beforeEach(() => {
    dir = TempDir.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  const pnpmContext = (
    workspace: string,
    manifest: Record<string, unknown>,
    extra: Partial<RuleContext> = {},
  ): RuleContext => {
    TempDir.write(dir, { 'pnpm-workspace.yaml': workspace });
    return RuleContextOf.make({
      root: dir,
      pnpmWorkspace: PnpmWorkspace.parse(workspace),
      manifests: [RuleContextOf.manifest(manifest)],
      lock: RuleContextOf.lock(
        ['good', 'denied', 'undecided', 'versioned', 'own', 'clean', 'nodata'].map((name) =>
          RuleContextOf.pkg(name, '1.0.0'),
        ),
      ),
      metadata: scripted(['good', 'denied', 'undecided', 'versioned', 'own']),
      config: { installScripts: { allow: { own: REASON } } },
      ...extra,
    });
  };

  it('pnpm 12: разрешённый, запрещённый, по версии и свой допуск — без находок; без решения — нарушение; без данных — не проверено', () => {
    const context = pnpmContext(
      "allowBuilds:\n  good: true\n  denied: false\n  'versioned@1.0.0 || 2.0.0': true\n",
      { packageManager: 'pnpm@12.4.1' },
    );
    expect(summary(context)).toEqual([
      ['violation', 'undecided@1.0.0'],
      ['unverified', '1 пакетов'],
    ]);
    expect(InstallScriptRule.run(context).checked).toBe(7);
  });

  it('pnpm 9 без onlyBuiltDependencies — настройка не запрещает остальные; с ним — запрещает', () => {
    const open = pnpmContext('allowBuilds: {}\n', { packageManager: 'pnpm@9.15.0' });
    expect(summary(open)).toContainEqual(['violation', 'onlyBuiltDependencies']);
    TempDir.remove(dir);
    dir = TempDir.create();
    const closed = pnpmContext('packages: []\n', {
      packageManager: 'pnpm@9.15.0',
      pnpm: { onlyBuiltDependencies: ['good'] },
    });
    expect(summary(closed).map(([, subject]) => subject)).not.toContain('onlyBuiltDependencies');
    TempDir.remove(dir);
    dir = TempDir.create();
    // pnpm 9 настройки из pnpm-workspace.yaml не читает (замер): там onlyBuiltDependencies не запрещает остальные.
    const workspaceOnly = pnpmContext('onlyBuiltDependencies:\n  - good\n', {
      packageManager: 'pnpm@9.15.0',
    });
    expect(summary(workspaceOnly).map(([, subject]) => subject)).toContain('onlyBuiltDependencies');
  });

  it('незафиксированная версия pnpm и dangerouslyAllowAllBuilds — нарушения настройки', () => {
    expect(summary(pnpmContext('packages: []\n', {}))).toContainEqual(['violation', 'packageManager']);
    TempDir.remove(dir);
    dir = TempDir.create();
    expect(
      summary(pnpmContext('dangerouslyAllowAllBuilds: true\n', { packageManager: 'pnpm@12.0.0' })),
    ).toContainEqual(['violation', 'dangerouslyAllowAllBuilds']);
  });

  it('dangerously-allow-all-builds в .npmrc снимает запрет у pnpm 10 (читаются все источники); pnpm 12 его не читает', () => {
    TempDir.write(dir, { '.npmrc': 'dangerously-allow-all-builds=true\n' });
    expect(summary(pnpmContext('packages: []\n', { packageManager: 'pnpm@10.0.0' }))).toContainEqual([
      'violation',
      'dangerouslyAllowAllBuilds',
    ]);
    expect(summary(pnpmContext('packages: []\n', { packageManager: 'pnpm@12.0.0' }))).not.toContainEqual([
      'violation',
      'dangerouslyAllowAllBuilds',
    ]);
  });

  it.each([
    ['отображение', 'allowBuilds:\n  good: {a: true}\n'],
    ['список', 'allowBuilds:\n  good: [a]\n'],
    ['не отображение', 'allowBuilds: [good]\n'],
  ])('битый allowBuilds (%s) — не прочитано, а не «решений нет»', (_name, workspace) => {
    expect(summary(pnpmContext(workspace, { packageManager: 'pnpm@12.0.0' }))).toEqual([
      ['broken', 'настройка скриптов'],
    ]);
  });

  it('npm: только свой список; запрет остальных не подтверждён — не проверено; подтверждён — нет', () => {
    const lock = RuleContextOf.lock(
      [
        RuleContextOf.pkg(
          'own',
          '1.0.0',
          { kind: 'tarball', url: 'https://r/own.tgz' },
          { installScript: true },
        ),
        RuleContextOf.pkg(
          'other',
          '1.0.0',
          { kind: 'tarball', url: 'https://r/other.tgz' },
          { installScript: true },
        ),
        RuleContextOf.pkg(
          'quiet',
          '1.0.0',
          { kind: 'tarball', url: 'https://r/quiet.tgz' },
          { installScript: false },
        ),
      ],
      { kind: 'npm', path: 'package-lock.json' },
    );
    const base = { root: dir, lock, manifests: [RuleContextOf.manifest({})] };
    expect(
      summary(RuleContextOf.make({ ...base, config: { installScripts: { allow: { own: REASON } } } })),
    ).toEqual([
      ['unverified', 'installScripts.othersBlockedBy'],
      ['violation', 'other@1.0.0'],
    ]);
    const declared = RuleContextOf.make({
      ...base,
      config: {
        installScripts: {
          allow: { own: REASON },
          othersBlockedBy: 'npm ci --ignore-scripts, затем npm rebuild own',
        },
      },
    });
    expect(summary(declared)).toEqual([['violation', 'other@1.0.0']]);
    TempDir.write(dir, { '.npmrc': 'ignore-scripts=true\n' });
    expect(summary(RuleContextOf.make(base))).toEqual([]);
  });

  it('решение по версии: запись другой версии пакет не решает; «||» без пробелов — тоже список', () => {
    const run = (entry: string): Array<[string, string]> =>
      summary(
        pnpmContext(
          `allowBuilds:\n  '${entry}': true\n`,
          { packageManager: 'pnpm@12.4.1' },
          {
            config: {},
            lock: RuleContextOf.lock([RuleContextOf.pkg('versioned', '1.0.0')]),
          },
        ),
      );
    expect(run('versioned@2.0.0')).toEqual([['violation', 'versioned@1.0.0']]);
    expect(run('versioned@1.0.0.1')).toEqual([['violation', 'versioned@1.0.0']]);
    expect(run('versioned@2.0.0||1.0.0')).toEqual([]);
    expect(run('versioned@2.0.0 ||1.0.0')).toEqual([]);
    expect(run('versioned@1.0.0')).toEqual([]);
  });

  it('pnpm 10 без onlyBuiltDependencies — запрет по умолчанию, нарушения настройки нет; pnpm 9 — есть', () => {
    const subjects = (manager: string): string[] =>
      summary(pnpmContext('allowBuilds: {}\n', { packageManager: manager })).map(([, subject]) => subject);
    expect(subjects('pnpm@10.0.0')).not.toContain('onlyBuiltDependencies');
    expect(subjects('pnpm@9.15.0')).toContain('onlyBuiltDependencies');
  });

  it('версия pnpm из devEngines.packageManager, если нет packageManager', () => {
    const subjects = (json: Record<string, unknown>): string[] =>
      summary(pnpmContext('allowBuilds: {}\n', json)).map(([, subject]) => subject);
    expect(subjects({ devEngines: { packageManager: { name: 'pnpm', version: '12.4.1' } } })).not.toContain(
      'packageManager',
    );
    expect(
      subjects({ devEngines: { packageManager: [{ name: 'pnpm', version: '^11.0.0' }] } }),
    ).not.toContain('packageManager');
    expect(subjects({ devEngines: { packageManager: { name: 'pnpm', version: '>=11' } } })).toContain(
      'packageManager',
    );
    expect(subjects({ devEngines: { packageManager: { name: 'yarn', version: '1.22.22' } } })).toContain(
      'packageManager',
    );
  });

  it('pnpm 11+: решения только из allowBuilds pnpm-workspace.yaml; onlyBuilt/поле pnpm/.npmrc не читаются', () => {
    TempDir.write(dir, { '.npmrc': 'ignore-scripts=true\ndangerously-allow-all-builds=true\n' });
    const context = pnpmContext(
      'onlyBuiltDependencies:\n  - good\nneverBuiltDependencies:\n  - denied\nallowBuilds:\n  own: true\n',
      { packageManager: 'pnpm@12.4.1', pnpm: { allowBuilds: { undecided: true } } },
      {
        lock: RuleContextOf.lock(
          ['good', 'denied', 'undecided', 'own'].map((name) => RuleContextOf.pkg(name, '1.0.0')),
        ),
      },
    );
    const findings = InstallScriptRule.run(context).findings;
    expect(findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['violation', 'good@1.0.0'],
      ['violation', 'denied@1.0.0'],
      ['violation', 'undecided@1.0.0'],
    ]);
    for (const unread of [
      'onlyBuiltDependencies',
      'neverBuiltDependencies',
      'package.json (pnpm): allowBuilds',
      '.npmrc: ignore-scripts',
    ]) {
      expect(findings[0]?.reason).toContain(unread);
    }
  });

  it('pnpm 11+: ignoreScripts и dangerouslyAllowAllBuilds в pnpm-workspace.yaml читаются', () => {
    expect(summary(pnpmContext('ignoreScripts: true\n', { packageManager: 'pnpm@11.1.3' }))).toEqual([]);
    TempDir.remove(dir);
    dir = TempDir.create();
    expect(
      summary(pnpmContext('dangerouslyAllowAllBuilds: true\n', { packageManager: 'pnpm@11.1.3' })),
    ).toContainEqual(['violation', 'dangerouslyAllowAllBuilds']);
  });

  it('pnpm < 10: решения из поля pnpm package.json и ignore-scripts .npmrc; pnpm-workspace.yaml не читается', () => {
    const fromField = pnpmContext(
      'onlyBuiltDependencies:\n  - undecided\n',
      {
        packageManager: 'pnpm@9.15.0',
        pnpm: { onlyBuiltDependencies: ['good'], neverBuiltDependencies: ['denied'] },
      },
      {
        config: {},
        lock: RuleContextOf.lock(
          ['good', 'denied', 'undecided'].map((name) => RuleContextOf.pkg(name, '1.0.0')),
        ),
      },
    );
    expect(summary(fromField)).toEqual([['violation', 'undecided@1.0.0']]);
    TempDir.write(dir, { '.npmrc': 'ignore-scripts=true\n' });
    expect(summary(pnpmContext('packages: []\n', { packageManager: 'pnpm@9.15.0' }))).toEqual([]);
  });

  it('pnpm < 10: onlyBuiltDependenciesFile — список из файла', () => {
    TempDir.write(dir, { 'allowed.json': JSON.stringify(['good']) });
    const context = pnpmContext(
      'packages: []\n',
      { packageManager: 'pnpm@9.15.0', pnpm: { onlyBuiltDependenciesFile: 'allowed.json' } },
      {
        config: {},
        lock: RuleContextOf.lock([
          RuleContextOf.pkg('good', '1.0.0'),
          RuleContextOf.pkg('undecided', '1.0.0'),
        ]),
      },
    );
    expect(summary(context)).toEqual([['violation', 'undecided@1.0.0']]);
    TempDir.write(dir, { 'allowed.json': '{"good": true}' });
    expect(summary(context)).toEqual([['broken', 'настройка скриптов']]);
  });

  it('yarn: ignore-scripts из .yarnrc; из .npmrc — нет (yarn 1 его не читает)', () => {
    const lock = RuleContextOf.lock(
      [
        RuleContextOf.pkg(
          'own',
          '1.0.0',
          { kind: 'tarball', url: 'https://r/own.tgz' },
          { installScript: true },
        ),
      ],
      {
        kind: 'yarn',
        path: 'yarn.lock',
      },
    );
    const base = { root: dir, lock, manifests: [RuleContextOf.manifest({})] };
    TempDir.write(dir, { '.npmrc': 'ignore-scripts=true\n' });
    const npmrc = InstallScriptRule.run(RuleContextOf.make(base)).findings;
    expect(npmrc.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['unverified', 'installScripts.othersBlockedBy'],
      ['violation', 'own@1.0.0'],
    ]);
    expect(npmrc[0]?.reason).toContain('.npmrc: ignore-scripts (yarn 1 его не читает');
    TempDir.write(dir, { '.yarnrc': '--ignore-scripts true\n' });
    expect(summary(RuleContextOf.make(base))).toEqual([]);
    TempDir.write(dir, { '.yarnrc': 'ignore-scripts false\n' });
    expect(summary(RuleContextOf.make(base)).map(([verdict]) => verdict)).toEqual([
      'unverified',
      'violation',
    ]);
  });

  it('npm: короткая причина othersBlockedBy — запрет остальных не подтверждён', () => {
    const lock = RuleContextOf.lock([], { kind: 'npm', path: 'package-lock.json' });
    const run = (othersBlockedBy: string): Array<[string, string]> =>
      summary(RuleContextOf.make({ root: dir, lock, config: { installScripts: { othersBlockedBy } } }));
    expect(run('ci')).toEqual([['unverified', 'installScripts.othersBlockedBy']]);
    expect(run('npm ci --ignore-scripts, затем npm rebuild разрешённых')).toEqual([]);
  });

  it('npm и yarn: dangerously-allow-all-builds в .npmrc — ключ pnpm, нарушением не считается', () => {
    TempDir.write(dir, { '.npmrc': 'dangerously-allow-all-builds=true\n' });
    const lock = RuleContextOf.lock([], { kind: 'npm', path: 'package-lock.json' });
    expect(
      summary(
        RuleContextOf.make({
          root: dir,
          lock,
          config: {
            installScripts: { othersBlockedBy: 'npm ci --ignore-scripts, затем npm rebuild разрешённых' },
          },
        }),
      ),
    ).toEqual([]);
  });

  it('допуск пакета, которого нет в дереве, — устарело; короткая причина — нарушение и не допуск', () => {
    const context = pnpmContext(
      'allowBuilds: {}\n',
      { packageManager: 'pnpm@12.0.0' },
      {
        config: { installScripts: { allow: { own: 'да', ghost: REASON } } },
        lock: RuleContextOf.lock([RuleContextOf.pkg('own', '1.0.0')]),
      },
    );
    expect(summary(context)).toEqual([
      ['violation', 'own@1.0.0'],
      ['violation', 'installScripts.allow["own"]'],
      ['stale', 'installScripts.allow["ghost"]'],
    ]);
  });

  it('признак скрипта: каталог file:-зависимости из репозитория; установленный node_modules не источник', () => {
    TempDir.write(dir, {
      'node_modules/.pnpm/hooked@1.0.0/node_modules/hooked/package.json': JSON.stringify({
        name: 'hooked',
        version: '1.0.0',
      }),
      'vendor/local/package.json': JSON.stringify({ name: 'local', scripts: { install: 'make' } }),
      'vendor/gyp/package.json': JSON.stringify({ name: 'gyp' }),
      'vendor/gyp/binding.gyp': '{}',
    });
    const context = pnpmContext(
      'allowBuilds: {}\n',
      { packageManager: 'pnpm@12.0.0' },
      {
        lock: RuleContextOf.lock([
          RuleContextOf.pkg('hooked', '1.0.0'),
          RuleContextOf.pkg('local', 'file:vendor/local', { kind: 'directory', url: 'vendor/local' }),
          RuleContextOf.pkg('gyp', 'file:vendor/gyp', { kind: 'directory', url: 'file:vendor/gyp' }),
        ]),
        metadata: new Map(),
        config: {},
      },
    );
    expect(summary(context)).toEqual([
      ['violation', 'local@file:vendor/local'],
      ['violation', 'gyp@file:vendor/gyp'],
      ['unverified', '1 пакетов'],
    ]);
  });

  it('pnpm 12: заглушка allowBuilds «set this to true or false» — пакет без решения (нарушение), а не «не прочитано»', () => {
    const context = pnpmContext(
      'allowBuilds:\n  good: true\n  denied: false\n  versioned: true\n  undecided: set this to true or false\n',
      { packageManager: 'pnpm@12.4.1' },
    );
    const findings = InstallScriptRule.run(context).findings;
    expect(findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['violation', 'undecided@1.0.0'],
      ['unverified', '1 пакетов'],
    ]);
    expect(findings[0]?.reason).toContain(
      'allowBuilds.undecided = «set this to true or false» — решения нет',
    );
  });

  it('git-зависимость: менеджер выполняет её prepare — нужен допуск; каталог со скриптом prepare — тоже', () => {
    TempDir.write(dir, {
      'vendor/prep/package.json': JSON.stringify({ name: 'prep', scripts: { prepare: 'tsc' } }),
      'vendor/plain/package.json': JSON.stringify({ name: 'plain', scripts: { build: 'tsc', test: 'jest' } }),
    });
    const context = RuleContextOf.make({
      root: dir,
      manifests: [RuleContextOf.manifest({})],
      lock: RuleContextOf.lock(
        [
          RuleContextOf.pkg('gitdep', '1.0.0', {
            kind: 'git',
            url: 'https://g.example/u/r',
            commit: 'a'.repeat(40),
          }),
          RuleContextOf.pkg('prep', 'file:vendor/prep', { kind: 'directory', url: 'vendor/prep' }),
          RuleContextOf.pkg('plain', 'file:vendor/plain', { kind: 'directory', url: 'vendor/plain' }),
        ],
        { kind: 'npm', path: 'package-lock.json' },
      ),
      config: { installScripts: { othersBlockedBy: REASON } },
    });
    expect(summary(context)).toEqual([
      ['violation', 'gitdep@1.0.0'],
      ['violation', 'prep@file:vendor/prep'],
    ]);
    const allowed = {
      ...context,
      config: { installScripts: { othersBlockedBy: REASON, allow: { gitdep: REASON, prep: REASON } } },
    };
    expect(summary(allowed)).toEqual([]);
  });

  it('npm: file:-каталог ставится ссылкой и npm выполняет его скрипты (prepare тоже); проект workspace — нет', () => {
    TempDir.write(dir, {
      'dep/package.json': JSON.stringify({ name: 'dep', scripts: { prepare: 'node build.js' } }),
      'packages/ws/package.json': JSON.stringify({ name: 'ws', scripts: { prepare: 'tsc' } }),
    });
    const context = RuleContextOf.make({
      root: dir,
      manifests: [
        RuleContextOf.manifest({ workspaces: ['packages/*'] }),
        RuleContextOf.manifest({}, 'packages/ws'),
      ],
      lock: RuleContextOf.lock(
        [
          RuleContextOf.pkg('dep', 'link:dep', { kind: 'link', url: 'dep' }),
          RuleContextOf.pkg('ws', 'link:packages/ws', { kind: 'link', url: 'packages/ws' }),
          RuleContextOf.pkg('out', 'link:../out', { kind: 'link', url: '../out' }),
        ],
        { kind: 'npm', path: 'package-lock.json' },
      ),
      config: { installScripts: { othersBlockedBy: REASON } },
    });
    expect(summary(context)).toEqual([['violation', 'dep@link:dep']]);
    expect(summary({ ...context, lock: { ...context.lock, kind: 'pnpm' } })).not.toContainEqual([
      'violation',
      'dep@link:dep',
    ]);
  });
});
