import { InputUnreadableError } from '../input-unreadable.error';
import { RuleContextOf } from '../testing/rule-context-of';
import { TempDir } from '../testing/temp-dir';
import type { BuildSettings } from '../types/build-settings.type';
import { ReadBuildSettings } from './read-build-settings';

/**
 * Решения о install-скриптах — ровно из тех источников, которые читает
 * менеджер этой версии; мажор pnpm — из `packageManager` или
 * `devEngines.packageManager`.
 */
describe('ReadBuildSettings', () => {
  let dir: string;

  beforeEach(() => {
    dir = TempDir.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  const read = (
    json: Record<string, unknown>,
    kind: 'pnpm' | 'npm' | 'yarn' | 'yarn-berry' = 'pnpm',
    workspace: Record<string, unknown> = {},
    files: Record<string, string> = {},
    berryFormat?: number,
  ): BuildSettings => {
    TempDir.write(dir, files);
    return ReadBuildSettings.read(dir, RuleContextOf.manifest(json), kind, workspace, berryFormat);
  };

  const plain = (settings: BuildSettings) => ({
    ...settings,
    allow: [...settings.allow].sort(),
    deny: [...settings.deny].sort(),
  });

  it.each([
    [{ packageManager: 'pnpm@12.4.1' }, 12],
    [{ packageManager: 'pnpm@9.15.0+sha512.abc' }, 9],
    [{ packageManager: 'pnpm@10.0.0' }, 10],
    [{ packageManager: 'xpnpm@12.4.1' }, undefined],
    [{ packageManager: 'pnpm@12.4' }, undefined],
    [{ packageManager: 'pnpm@12' }, undefined],
    [{ packageManager: 'yarn@1.22.22' }, undefined],
    [{ packageManager: 1 }, undefined],
    [{ devEngines: { packageManager: { name: 'pnpm', version: '11.1.3' } } }, 11],
    [{ devEngines: { packageManager: { name: 'pnpm', version: '^11.1.3' } } }, 11],
    [
      {
        devEngines: {
          packageManager: [
            { name: 'npm', version: '10.0.0' },
            { name: 'pnpm', version: '9.1.0' },
          ],
        },
      },
      9,
    ],
    [{ devEngines: { packageManager: { name: 'pnpm', version: '>=11.1.3' } } }, undefined],
    [{ devEngines: { packageManager: { name: 'pnpm', version: '11.1.3 || 12.0.0' } } }, undefined],
    [{ devEngines: { packageManager: { name: 'pnpm', version: 'x11.1.3' } } }, undefined],
    [{ devEngines: { packageManager: { name: 'pnpm', version: '11.1' } } }, undefined],
    [{ devEngines: { packageManager: { name: 'pnpm', version: '11.1.3x' } } }, undefined],
    [{ devEngines: { packageManager: { name: 'pnpm', version: '0.1.0' } } }, undefined],
    [{ devEngines: { packageManager: { name: 'yarn', version: '11.1.3' } } }, undefined],
    [{ devEngines: { packageManager: null } }, undefined],
    [{}, undefined],
  ])('мажор pnpm: %j → %s', (json, major) => {
    expect(read(json).pnpmMajor).toBe(major);
  });

  it('pnpm 12: только pnpm-workspace.yaml — allowBuilds, dangerouslyAllowAllBuilds, ignoreScripts; прочее — «не читает»', () => {
    const settings = read(
      { packageManager: 'pnpm@12.4.1', pnpm: { onlyBuiltDependencies: ['field'] } },
      'pnpm',
      {
        allowBuilds: { good: true, bad: false, stub: 'set this to true or false' },
        onlyBuiltDependencies: ['old'],
        ignoreScripts: false,
        dangerouslyAllowAllBuilds: false,
      },
      { '.npmrc': 'ignore-scripts=true\n' },
    );
    expect(plain(settings)).toEqual({
      manager: 'pnpm',
      pnpmMajor: 12,
      pnpmVersion: '12.4',
      allow: ['good'],
      deny: ['bad'],
      hasOnlyBuiltDependencies: false,
      allowAll: false,
      ignoreScripts: false,
      sources: ['pnpm-workspace.yaml'],
      unread: [
        'pnpm-workspace.yaml: allowBuilds.stub = «set this to true or false» — решения нет (нужно true или false)',
        'pnpm-workspace.yaml: onlyBuiltDependencies (pnpm 12 его не читает)',
        'package.json (pnpm): onlyBuiltDependencies (pnpm 12 его не читает)',
        '.npmrc: ignore-scripts (pnpm 12 его не читает)',
      ],
    });
  });

  it.each([
    [{ dangerouslyAllowAllBuilds: true }, { allowAll: true, ignoreScripts: false }],
    [{ ignoreScripts: true }, { allowAll: false, ignoreScripts: true }],
    [
      { dangerouslyAllowAllBuilds: false, ignoreScripts: false },
      { allowAll: false, ignoreScripts: false },
    ],
  ])('pnpm 12: флаги %j', (workspace, expected) => {
    expect(read({ packageManager: 'pnpm@12.4.1' }, 'pnpm', workspace)).toMatchObject(expected);
  });

  it('pnpm 9: поле pnpm package.json и .npmrc; pnpm-workspace.yaml не читается', () => {
    const settings = read(
      {
        packageManager: 'pnpm@9.15.0',
        pnpm: { onlyBuiltDependencies: ['a'], neverBuiltDependencies: ['b'], allowBuilds: { c: true } },
      },
      'pnpm',
      { allowBuilds: { d: true } },
      { '.npmrc': 'dangerously-allow-all-builds=true\n' },
    );
    expect(plain(settings)).toMatchObject({
      allow: ['a'],
      deny: ['b'],
      hasOnlyBuiltDependencies: true,
      allowAll: false,
      sources: ['package.json (pnpm)'],
      unread: [
        'pnpm-workspace.yaml: allowBuilds (pnpm 9 его не читает)',
        'package.json (pnpm): allowBuilds (pnpm 9 его не читает)',
        '.npmrc: dangerously-allow-all-builds (pnpm 9 его не читает)',
      ],
    });
    expect(
      read({ packageManager: 'pnpm@9.15.0' }, 'pnpm', {}, { '.npmrc': 'ignore-scripts=true\n' })
        .ignoreScripts,
    ).toBe(true);
  });

  it('pnpm 9: onlyBuiltDependenciesFile — список из файла; не путь или битый файл — отказ', () => {
    const settings = read(
      { packageManager: 'pnpm@9.15.0', pnpm: { onlyBuiltDependenciesFile: 'allowed.json' } },
      'pnpm',
      {},
      { 'allowed.json': '["x", "y"]' },
    );
    expect(plain(settings)).toMatchObject({ allow: ['x', 'y'], hasOnlyBuiltDependencies: true });
    expect(() => read({ packageManager: 'pnpm@9.15.0', pnpm: { onlyBuiltDependenciesFile: ' ' } })).toThrow(
      InputUnreadableError,
    );
    expect(() => read({ packageManager: 'pnpm@9.15.0', pnpm: { onlyBuiltDependenciesFile: 1 } })).toThrow(
      InputUnreadableError,
    );
    expect(() =>
      read({ packageManager: 'pnpm@9.15.0', pnpm: { onlyBuiltDependenciesFile: 'none.json' } }),
    ).toThrow(/onlyBuiltDependenciesFile не прочитан/);
  });

  it('pnpm 10 и незафиксированная версия — все источники разом', () => {
    const settings = read(
      { packageManager: 'pnpm@10.33.3', pnpm: { neverBuiltDependencies: ['n'] } },
      'pnpm',
      { allowBuilds: { a: true }, ignoredBuiltDependencies: ['i'] },
      { '.npmrc': 'dangerously-allow-all-builds=true\n' },
    );
    expect(plain(settings)).toMatchObject({
      pnpmMajor: 10,
      allow: ['a'],
      deny: ['i', 'n'],
      allowAll: true,
      sources: ['pnpm-workspace.yaml', 'package.json (pnpm)'],
      unread: [],
    });
    expect(read({}, 'pnpm', { allowBuilds: { a: true } }).unread).toEqual([]);
  });

  it.each([
    [{ allowBuilds: ['a'] }, 'allowBuilds: ожидалось отображение'],
    [{ allowBuilds: 'a' }, 'allowBuilds: ожидалось отображение'],
    [{ allowBuilds: { a: 1 } }, 'allowBuilds.a: ожидалось true или false'],
    [{ ignoreScripts: 'yes' }, 'ignoreScripts: ожидалось true или false'],
    [{ dangerouslyAllowAllBuilds: 1 }, 'dangerouslyAllowAllBuilds: ожидалось true или false'],
    [{ onlyBuiltDependencies: 'a' }, 'onlyBuiltDependencies: ожидался список имён'],
    [{ onlyBuiltDependencies: ['a', 1] }, 'onlyBuiltDependencies: ожидался список имён'],
  ])('pnpm 10: неверная форма %j — отказ', (workspace, message) => {
    expect(() => read({ packageManager: 'pnpm@10.0.0' }, 'pnpm', workspace)).toThrow(message);
  });

  /**
   * pnpm 12.11+: `permissions.<ключ>.build`. Таблица — ответы настоящего pnpm
   * 12.11.0 и 12.21.0 (маркер postinstall и `pnpm permissions`) на те же
   * pnpm-workspace.yaml; pnpm 12.10.1 `permissions` не читает («not
   * recognized», скрипт не выполнен).
   */
  describe('pnpm 12.11+: permissions', () => {
    const decided = (workspace: Record<string, unknown>, packageManager = 'pnpm@12.21.0') => {
      const settings = plain(read({ packageManager }, 'pnpm', workspace));
      return { allow: settings.allow, deny: settings.deny, unread: settings.unread };
    };

    it.each([
      [
        'allowBuilds: false + permissions.build: true — разрешён',
        { allowBuilds: { a: false }, permissions: { a: { build: true } } },
        ['a'],
        [],
      ],
      ['только permissions.build: true — разрешён', { permissions: { a: { build: true } } }, ['a'], []],
      [
        'allowBuilds: true + permissions.build: false — запрещён',
        { allowBuilds: { a: true }, permissions: { a: { build: false } } },
        [],
        ['a'],
      ],
      ['только permissions.build: false — запрещён', { permissions: { a: { build: false } } }, [], ['a']],
      [
        'permissions без build — решает allowBuilds',
        { allowBuilds: { a: true }, permissions: { a: { skills: [] } } },
        ['a'],
        [],
      ],
      [
        'build: null — решает allowBuilds',
        { allowBuilds: { a: true }, permissions: { a: { build: null } } },
        ['a'],
        [],
      ],
      [
        'permissions другого пакета не трогает allowBuilds',
        { allowBuilds: { a: true }, permissions: { b: { build: true } } },
        ['a', 'b'],
        [],
      ],
      ['ключ с версией', { permissions: { 'a@1.0.0': { build: true } } }, ['a@1.0.0'], []],
      [
        'permissions: {} и null — решает allowBuilds',
        { allowBuilds: { a: true }, permissions: {} },
        ['a'],
        [],
      ],
      [
        'разные ключи одного пакета — оба решения записаны',
        { allowBuilds: { 'a@1.0.0': false }, permissions: { a: { build: true } } },
        ['a'],
        ['a@1.0.0'],
      ],
    ])('%s', (_name, workspace, allow, deny) => {
      expect(decided(workspace)).toEqual({ allow, deny, unread: [] });
    });

    it('строка вместо булева (и заглушка) — решения нет, названа', () => {
      expect(
        decided({ permissions: { a: { build: 'true' }, b: { build: 'set this to true or false' } } }),
      ).toEqual({
        allow: [],
        deny: [],
        unread: [
          'pnpm-workspace.yaml: permissions.a.build = «true» — решения нет (нужно true или false)',
          'pnpm-workspace.yaml: permissions.b.build = «set this to true or false» — решения нет (нужно true или false)',
        ],
      });
    });

    it.each([
      [{ permissions: { a: true } }, 'permissions.a: ожидалось отображение возможностей'],
      [{ permissions: { a: { build: 1 } } }, 'permissions.a.build: ожидалось true или false'],
      [{ permissions: ['a'] }, 'permissions: ожидалось отображение'],
    ])('%j — отказ (pnpm отвечает ERR_PNPM_INVALID_SETTING)', (workspace, message) => {
      expect(() => read({ packageManager: 'pnpm@12.21.0' }, 'pnpm', workspace)).toThrow(message);
    });

    it.each([
      ['pnpm@12.10.1', [], ['pnpm-workspace.yaml: permissions (pnpm 12.10 его не читает — нужен 12.11+)']],
      ['pnpm@11.1.3', [], ['pnpm-workspace.yaml: permissions (pnpm 11.1 его не читает — нужен 12.11+)']],
      ['pnpm@12.11.0', ['a'], []],
      ['pnpm@13.0.0', ['a'], []],
    ])('%s: permissions.build читается — %j', (packageManager, allow, unread) => {
      expect(decided({ permissions: { a: { build: true } } }, packageManager)).toEqual({
        allow,
        deny: [],
        unread,
      });
    });

    it('devEngines ^12.11.0 читает permissions, ^12.0.0 — нет (не каждая допустимая версия читает); без закрепления — все источники', () => {
      const engines = (version: string) => ({ devEngines: { packageManager: { name: 'pnpm', version } } });
      expect(plain(read(engines('^12.11.0'), 'pnpm', { permissions: { a: { build: true } } })).allow).toEqual(
        ['a'],
      );
      expect(plain(read(engines('^12.0.0'), 'pnpm', { permissions: { a: { build: true } } }))).toMatchObject({
        allow: [],
        unread: ['pnpm-workspace.yaml: permissions (pnpm 12.0 его не читает — нужен 12.11+)'],
      });
      expect(plain(read({}, 'pnpm', { permissions: { a: { build: true } } })).allow).toEqual(['a']);
    });
  });

  it('null и отсутствие ключа — не решение и не источник', () => {
    const settings = read({ packageManager: 'pnpm@12.4.1', pnpm: [] }, 'pnpm', { allowBuilds: null });
    expect(plain(settings)).toMatchObject({ allow: [], deny: [], sources: [], unread: [] });
  });

  it('npm: ignore-scripts из .npmrc; .yarnrc и pnpm-workspace.yaml не читаются', () => {
    expect(
      read({}, 'npm', { ignoreScripts: true }, { '.npmrc': 'ignore-scripts=true\n' }).ignoreScripts,
    ).toBe(true);
    expect(read({}, 'npm', {}, { '.npmrc': 'ignore-scripts=false\n' }).ignoreScripts).toBe(false);
    const fromYarnrc = read({}, 'npm', {}, { '.npmrc': 'x=1\n', '.yarnrc': 'ignore-scripts true\n' });
    expect(fromYarnrc).toEqual({
      manager: 'npm',
      allow: new Set(),
      deny: new Set(),
      hasOnlyBuiltDependencies: false,
      allowAll: false,
      ignoreScripts: false,
      sources: [],
      unread: [],
    });
  });

  it('yarn: ignore-scripts из .yarnrc; в .npmrc — «не читает»', () => {
    expect(read({}, 'yarn', {}, { '.yarnrc': 'ignore-scripts true\n' })).toMatchObject({
      ignoreScripts: true,
      unread: [],
    });
    expect(read({}, 'yarn', {}, { '.yarnrc': 'ignore-scripts false\n' }).ignoreScripts).toBe(false);
    expect(read({}, 'yarn', {}, { '.npmrc': 'ignore-scripts=true\n' })).toMatchObject({
      ignoreScripts: false,
      unread: [expect.stringContaining('.npmrc: ignore-scripts')],
    });
    expect(read({}, 'yarn', {}, { '.npmrc': 'registry=https://r.example/\n' }).unread).toEqual([]);
  });

  it('ключ в секции .npmrc и вложенный ключ .yarnrc — отказ, а не решение', () => {
    expect(() =>
      read({}, 'npm', {}, { '.npmrc': 'ignore-scripts=false\n[ci]\nignore-scripts=true\n' }),
    ).toThrow(InputUnreadableError);
    expect(() => read({}, 'yarn', {}, { '.yarnrc': 'ci:\n  ignore-scripts true\n' })).toThrow(
      InputUnreadableError,
    );
  });

  describe('yarn 2+', () => {
    it('enableScripts по умолчанию — скрипты всех; built: true/false — решения; .npmrc и .yarnrc — «не читает»', () => {
      const settings = read(
        { dependenciesMeta: { a: { built: true }, 'b@1.0.0': { built: false }, c: { optional: true } } },
        'yarn-berry',
        {},
        { '.npmrc': 'ignore-scripts=true\n', '.yarnrc': 'ignore-scripts true\n' },
      );
      expect(plain(settings)).toEqual({
        manager: 'yarn-berry',
        allow: ['a'],
        deny: ['b@1.0.0'],
        hasOnlyBuiltDependencies: false,
        allowAll: false,
        ignoreScripts: false,
        execGated: false,
        sources: ['package.json'],
        unread: [
          expect.stringContaining('.npmrc: ignore-scripts (yarn 2+'),
          expect.stringContaining('.yarnrc: ignore-scripts (yarn 2+'),
        ],
      });
    });

    it.each([
      ['enableScripts: false\n', true, ['.yarnrc.yml'], []],
      ['enableScripts: true\n', false, ['.yarnrc.yml'], []],
      [
        `enableScripts: "${'$'}{X:-false}"\n`,
        false,
        [],
        [expect.stringContaining('из переменной окружения')],
      ],
      ['nodeLinker: pnp\n', false, [], []],
    ])('%j: остальные запрещены — %s', (yml, blocked, sources, unread) => {
      expect(read({}, 'yarn-berry', {}, { '.yarnrc.yml': yml })).toMatchObject({
        hasOnlyBuiltDependencies: blocked,
        sources,
        unread,
      });
    });

    /**
     * Без enableScripts решает формат yarn.lock. Замер на настоящем yarn:
     * 4.13.0 (формат 8) выполняет postinstall обоих пакетов, 4.14.0/4.14.1
     * (9) и 4.15.0/4.18.1 (10) — ни одного; yarn 4.18.1 на файле формата 8
     * дописывает `enableScripts: true`, а с `--immutable` (CI) отказывает;
     * yarn 4.13.0 на файле формата 10 с `--immutable` отказывает.
     */
    it.each([
      [8, '', false, false],
      [9, '', true, true],
      [10, '', true, true],
      [10, 'enableScripts: true\n', false, true],
      [10, 'enableScripts: false\n', true, true],
      [10, 'enableImmutableInstalls: false\n', false, false],
      [10, `enableImmutableInstalls: "${'$'}{CI_IMMUTABLE}"\n`, false, false],
      [undefined, '', false, false],
    ])(
      'формат %s, %j: остальные запрещены — %s, exec: по настройке скриптов — %s',
      (format, yml, blocked, gated) => {
        expect(
          read({}, 'yarn-berry', {}, yml === '' ? {} : { '.yarnrc.yml': yml }, format as number | undefined),
        ).toMatchObject({ hasOnlyBuiltDependencies: blocked, execGated: gated });
      },
    );

    it('формат 10 без enableScripts — запрет умолчанием (помечен), неизменяемость снята — названа', () => {
      expect(read({}, 'yarn-berry', {}, {}, 10)).toMatchObject({
        blockedByDefault: true,
        sources: [],
        unread: [],
      });
      expect(
        read({}, 'yarn-berry', {}, { '.yarnrc.yml': 'enableImmutableInstalls: false\n' }, 10).unread,
      ).toEqual([
        expect.stringContaining(
          'enableImmutableInstalls false — yarn младше 4.14 поставит yarn.lock формата 10',
        ),
      ]);
      expect(
        read({}, 'yarn-berry', {}, { '.yarnrc.yml': 'enableScripts: false\n' }, 10).blockedByDefault,
      ).toBeUndefined();
    });

    it.each([
      [{ dependenciesMeta: [] }, 'dependenciesMeta: ожидалось отображение'],
      [{ dependenciesMeta: { a: true } }, 'dependenciesMeta.a: ожидалось отображение'],
      [{ dependenciesMeta: { a: { built: 'true' } } }, 'dependenciesMeta.a.built: ожидалось true или false'],
    ])('%j — отказ', (json, message) => {
      expect(() => read(json, 'yarn-berry')).toThrow(message);
    });
  });
});
