import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import { TempDir } from '../testing/temp-dir';
import { PackageKey } from './package-key';
import { ParsePnpmLock } from './parse-pnpm-lock';

describe('ParsePnpmLock', () => {
  it('настоящий lock pnpm 12: оба документа, источники, прямые зависимости и ссылки', () => {
    const text = readFileSync(join(TempDir.FIXTURES, 'pnpm-project', 'head', 'pnpm-lock.yaml'), 'utf8');
    const lock = ParsePnpmLock.parse(text, 'pnpm-lock.yaml');
    const byId = new Map(lock.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
    expect(byId.get('pnpm@12.4.1')?.source).toEqual({ kind: 'registry-default' });
    expect(byId.get('ms@2.1.3')?.integrity).toMatch(/^sha512-/);
    expect(byId.get('native-hook@file:vendor/native-hook')?.source).toEqual({
      kind: 'directory',
      url: 'vendor/native-hook',
    });
    expect(lock.packages.every((pkg) => pkg.installScript === undefined)).toBe(true);
    expect({ ...lock.importers?.['.'] }).toEqual({
      debug: {
        field: 'dependencies',
        specifier: '4.4.3',
        version: '4.4.3',
        line: expect.any(Number),
        target: 'debug@4.4.3',
      },
      ms: {
        field: 'dependencies',
        specifier: '2.1.3',
        version: '2.1.3',
        line: expect.any(Number),
        target: 'ms@2.1.3',
      },
      'plain-lib': {
        field: 'dependencies',
        specifier: 'file:./vendor/plain-lib',
        version: 'file:vendor/plain-lib',
        line: expect.any(Number),
        target: 'plain-lib@file:vendor/plain-lib',
      },
      'native-hook': {
        field: 'devDependencies',
        specifier: 'file:./vendor/native-hook',
        version: 'file:vendor/native-hook',
        line: expect.any(Number),
        target: 'native-hook@file:vendor/native-hook',
      },
      semver: {
        field: 'devDependencies',
        specifier: '^7.7.4',
        version: '7.8.6',
        line: expect.any(Number),
        target: 'semver@7.8.6',
      },
    });
    // 14 бинарных сборок pnpm + сам pnpm (документ окружения) + 5 пакетов проекта.
    expect(lock.packages.length).toBe(20);
    const line = byId.get('semver@7.8.6')?.line as number;
    expect(text.split('\n')[line - 1]).toBe('  semver@7.8.6:');
  });

  it('lockfile v6: ключи с «/», requiresBuild, git/tarball, link и зависимости в корне', () => {
    const text = [
      "lockfileVersion: '6.0'",
      'dependencies:',
      '  a:',
      '    specifier: ^1.0.0',
      '    version: 1.0.0',
      '  local:',
      '    specifier: link:../outside',
      '    version: link:../outside',
      'packages:',
      '  /a@1.0.0:',
      '    resolution: {integrity: sha512-x==}',
      '    requiresBuild: true',
      '  /@s/b@2.0.0(react@18.0.0):',
      '    resolution: {integrity: sha512-y==, tarball: https://evil.example/b.tgz}',
      '  github.com/u/r/0123456789abcdef0123456789abcdef01234567:',
      '    resolution: {type: git, repo: https://github.com/u/r, commit: 0123456789abcdef0123456789abcdef01234567}',
      '    name: r',
      '    version: 0.0.1',
      '',
    ].join('\n');
    const lock = ParsePnpmLock.parse(text, 'pnpm-lock.yaml');
    expect(lock.packages.map((pkg) => [pkg.name, pkg.version, pkg.source.kind, pkg.installScript])).toEqual([
      ['a', '1.0.0', 'registry-default', true],
      ['@s/b', '2.0.0', 'tarball', false],
      ['r', '0.0.1', 'git', false],
      ['local', 'link:../outside', 'link', undefined],
    ]);
    expect(lock.packages[3]?.source.url).toBe('../outside');
  });

  it('overrides, excludeLinksFromLockfile, config-зависимости, висячие ссылки, абсолютная ссылка', () => {
    const text = [
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    configDependencies:',
      '      cfg:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      'packages:',
      '  cfg@1.0.0:',
      '    resolution: {integrity: sha512-c==}',
      '---',
      "lockfileVersion: '9.0'",
      'settings:',
      '  excludeLinksFromLockfile: true',
      'overrides:',
      '  loc: file:./local2',
      "  'a@^1': 1.0.1",
      'importers:',
      '  .:',
      '    dependencies:',
      '      a:',
      '        specifier: ^1.0.0',
      '        version: 1.0.0(react@18.0.0)',
      '      alias:',
      '        specifier: npm:b@2.0.0',
      '        version: b@2.0.0',
      '      gone:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '      abs:',
      '        specifier: link:/etc/evil',
      '        version: link:/etc/evil',
      '  packages/p:',
      '    dependencies:',
      '      constructor:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '      sib:',
      '        specifier: link:../q',
      '        version: link:../q',
      'packages:',
      '  a@1.0.0:',
      '    resolution: {integrity: sha512-a==}',
      '  b@2.0.0:',
      '    resolution: {integrity: sha512-b==}',
      '  constructor@1.0.0:',
      '    resolution: {integrity: sha512-k==}',
      '',
    ].join('\n');
    const lock = ParsePnpmLock.parse(text, 'pnpm-lock.yaml');
    expect({ ...lock.overrides }).toEqual({ loc: 'file:./local2', 'a@^1': '1.0.1' });
    expect(lock.linksOmitted).toBe(true);
    expect({ ...lock.configDependencies }).toEqual({
      cfg: { specifier: '1.0.0', version: '1.0.0', line: 6, target: 'cfg@1.0.0' },
    });
    expect(lock.dangling).toEqual([{ importer: '.', name: 'gone', version: '1.0.0', line: 28 }]);
    expect(
      lock.packages.filter((pkg) => pkg.source.kind === 'link').map((pkg) => [pkg.name, pkg.source.url]),
    ).toEqual([
      ['abs', '/etc/evil'],
      ['sib', 'packages/q'],
    ]);
  });

  it.each([
    [
      'excludeLinksFromLockfile: yes',
      "lockfileVersion: '9.0'\nsettings:\n  excludeLinksFromLockfile: 'yes'\n",
      3,
    ],
    [
      'requiresBuild строкой (v6)',
      "lockfileVersion: '6.0'\npackages:\n  /a@1.0.0:\n    resolution: {integrity: sha512-a}\n    requiresBuild: 'true'\n",
      5,
    ],
    [
      'версия прямой зависимости не строкой',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a:\n        specifier: 1.0.0\n        version: true\n",
      5,
    ],
  ])('%s — отказ: менеджеры читают такое по-разному', (_name, text, line) => {
    expect(() => ParsePnpmLock.parse(text, 'pnpm-lock.yaml')).toThrow(expect.objectContaining({ line }));
  });

  it('LINK: в версии прямой зависимости — ссылка, а не висячая', () => {
    const lock = ParsePnpmLock.parse(
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      l:\n        specifier: LINK:../l\n        version: LINK:../l\n",
      'pnpm-lock.yaml',
    );
    expect(lock.dangling).toEqual([]);
    expect(lock.packages.map((pkg) => [pkg.name, pkg.source])).toEqual([
      ['l', { kind: 'link', url: '../l' }],
    ]);
  });

  it('lockfile без settings — ссылки в importers пишутся', () => {
    const lock = ParsePnpmLock.parse("lockfileVersion: '9.0'\nimporters:\n  .: {}\n", 'pnpm-lock.yaml');
    expect([lock.linksOmitted, lock.dangling, { ...lock.overrides }]).toEqual([false, [], {}]);
  });

  it.each(['6.0', '6.1', '9.0', '9.10'])('lockfileVersion %s — разбирается', (version) => {
    expect(ParsePnpmLock.parse(`lockfileVersion: '${version}'\n`, 'pnpm-lock.yaml').kind).toBe('pnpm');
  });

  it.each(['5.4', '19.0', '9.0.1', '9.', '9', 'v9.0', '9.0x', '10.0'])(
    'lockfileVersion %s — отказ со строкой ключа',
    (version) => {
      expect(() => ParsePnpmLock.parse(`a: b\nlockfileVersion: '${version}'\n`, 'pnpm-lock.yaml')).toThrow(
        expect.objectContaining({
          line: 2,
          message: expect.stringContaining(`«${version}» не поддерживается`),
        }),
      );
    },
  );

  it('ошибка YAML — путь и строка один раз, без «строка N» в причине', () => {
    expect(() =>
      ParsePnpmLock.parse("lockfileVersion: '9.0'\npackages:\n  a@1: &x {}\n", 'pnpm-lock.yaml'),
    ).toThrow(expect.objectContaining({ line: 3, message: expect.not.stringMatching(/строка/) }));
  });

  it.each([
    ['overrides не строки', "lockfileVersion: '9.0'\noverrides:\n  a: {b: 1}\n"],
    [
      'configDependencies без specifier',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies:\n      a: {version: 1.0.0}\n",
    ],
    ['неподдерживаемая версия', "lockfileVersion: '5.4'\n"],
    ['нет lockfileVersion', 'packages: {}\n'],
    ['битый YAML', "lockfileVersion: '9.0'\npackages:\n  a@1: &x {}\n"],
    ['запись без имени', "lockfileVersion: '9.0'\npackages:\n  '@@':\n    resolution: {integrity: x}\n"],
    [
      'importer без specifier',
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a: {version: 1.0.0}\n",
    ],
  ])('%s — InputUnreadableError', (_name, text) => {
    expect(() => ParsePnpmLock.parse(text, 'pnpm-lock.yaml')).toThrow(InputUnreadableError);
  });

  it('настоящий lock pnpm 12.21.0: пакеты packageManagerDependencies (pnpm и его сборки) помечены, дерево проекта — нет', () => {
    const text = readFileSync(join(TempDir.FIXTURES, 'latest', 'pnpm-12.21.0', 'pnpm-lock.yaml'), 'utf8');
    const lock = ParsePnpmLock.parse(text, 'pnpm-lock.yaml');
    const marked = lock.packages.filter((pkg) => pkg.packageManager === true).map((pkg) => pkg.name);
    expect(marked).toHaveLength(16);
    expect(marked).toContain('pnpm');
    expect(marked.filter((name) => name !== 'pnpm').every((name) => name.startsWith('@pnpm/exe.'))).toBe(
      true,
    );
    expect(
      lock.packages
        .filter((pkg) => pkg.packageManager !== true)
        .map((pkg) => pkg.name)
        .sort(),
    ).toEqual([
      'd',
      'es5-ext',
      'es6-iterator',
      'es6-symbol',
      'esniff',
      'event-emitter',
      'ext',
      'next-tick',
      'type',
    ]);
  });

  it('пакет, до которого доходит и config-зависимость, и тот же пакет в дереве проекта — не помечены', () => {
    const text = [
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    configDependencies:',
      '      cfg:',
      '        specifier: 1.0.0',
      '        version: 1.0.0',
      '    packageManagerDependencies:',
      '      pnpm:',
      '        specifier: 12.21.0',
      '        version: 12.21.0',
      'packages:',
      '  cfg@1.0.0:',
      '    resolution: {integrity: sha512-AA==}',
      '  shared@1.0.0:',
      '    resolution: {integrity: sha512-AA==}',
      '  pnpm@12.21.0:',
      '    resolution: {integrity: sha512-AA==}',
      'snapshots:',
      '  cfg@1.0.0:',
      '    dependencies:',
      '      shared: 1.0.0',
      '  shared@1.0.0: {}',
      '  pnpm@12.21.0:',
      '    optionalDependencies:',
      '      shared: 1.0.0',
      '---',
      "lockfileVersion: '9.0'",
      'importers:',
      '  .:',
      '    dependencies:',
      '      pnpm:',
      '        specifier: 12.21.0',
      '        version: 12.21.0',
      'packages:',
      '  pnpm@12.21.0:',
      '    resolution: {integrity: sha512-AA==}',
      'snapshots:',
      '  pnpm@12.21.0: {}',
      '',
    ].join('\n');
    const lock = ParsePnpmLock.parse(text, 'pnpm-lock.yaml');
    expect(lock.packages.map((pkg) => `${pkg.name}:${pkg.packageManager === true}`)).toEqual([
      'cfg:false',
      'shared:false',
      'pnpm:true',
      'pnpm:false',
    ]);
  });

  it('PackageKey: scope, адрес в версии, суффикс peer', () => {
    expect(PackageKey.split('@babel/core@7.29.13')).toEqual({ name: '@babel/core', version: '7.29.13' });
    expect(PackageKey.split('x@https://h/@y/x.tgz')).toEqual({ name: 'x', version: 'https://h/@y/x.tgz' });
    expect(PackageKey.split('/ts-jest@29.1.0(jest@29.0.0)')).toEqual({ name: 'ts-jest', version: '29.1.0' });
    expect(PackageKey.split('@scope')).toBeUndefined();
    expect(PackageKey.split('noversion')).toBeUndefined();
  });
});
