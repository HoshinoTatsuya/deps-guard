import { InputUnreadableError } from '../input-unreadable.error';
import type { Lockfile } from '../types/lockfile.type';
import { ParseNpmLock } from './parse-npm-lock';
import { ParsePnpmLock } from './parse-pnpm-lock';
import { ParseYarnBerryLock } from './parse-yarn-berry-lock';
import { ParseYarnLock } from './parse-yarn-lock';

/** Рёбра дерева (`LockedPackage.dependencies`) и цели прямых зависимостей (`target`) у каждого формата. */
const edges = (lock: Lockfile): Record<string, readonly string[]> =>
  Object.fromEntries(lock.packages.map((pkg) => [pkg.key, pkg.dependencies ?? []]));

const targets = (lock: Lockfile): Record<string, Record<string, string | undefined>> =>
  Object.fromEntries(
    Object.entries(lock.importers ?? {}).map(([importer, directs]) => [
      importer,
      Object.fromEntries(Object.entries(directs).map(([name, direct]) => [name, direct.target])),
    ]),
  );

describe('рёбра дерева зависимостей', () => {
  it('pnpm v6: ключи с «/» и суффиксом peer, алиас ключом цели, optional; link: — не ребро и не цель', () => {
    const lock = ParsePnpmLock.parse(
      [
        "lockfileVersion: '6.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      adapter:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0(old-orm@1.0.0)',
        '      db:',
        '        specifier: npm:old-orm@^1.0.0',
        '        version: /old-orm@1.0.0',
        '      local:',
        '        specifier: link:../local',
        '        version: link:../local',
        'packages:',
        '  /adapter@1.0.0(old-orm@1.0.0):',
        '    resolution: {integrity: sha512-a}',
        '    peerDependencies:',
        '      old-orm: ^1.0.0',
        '    dependencies:',
        '      old-orm: 1.0.0',
        '    optionalDependencies:',
        '      helper: 2.0.0',
        '  /helper@2.0.0:',
        '    resolution: {integrity: sha512-h}',
        '    dependencies:',
        '      inner: /old-orm@1.0.0',
        '  /old-orm@1.0.0:',
        '    resolution: {integrity: sha512-o}',
        '',
      ].join('\n'),
      'pnpm-lock.yaml',
    );
    expect(edges(lock)).toEqual({
      '/adapter@1.0.0(old-orm@1.0.0)': ['/old-orm@1.0.0', '/helper@2.0.0'],
      '/helper@2.0.0': ['/old-orm@1.0.0'],
      '/old-orm@1.0.0': [],
      '. → local': [],
    });
    expect(targets(lock)).toEqual({
      '.': { adapter: '/adapter@1.0.0(old-orm@1.0.0)', db: '/old-orm@1.0.0', local: undefined },
    });
  });

  it('pnpm v9: рёбра из snapshots (peer-варианты — один пакет), config-зависимость документа окружения — цель', () => {
    const lock = ParsePnpmLock.parse(
      [
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
        '    resolution: {integrity: sha512-c}',
        'snapshots:',
        '  cfg@1.0.0: {}',
        '---',
        "lockfileVersion: '9.0'",
        'importers:',
        '  .:',
        '    dependencies:',
        '      needs:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0(old-orm@1.0.0)',
        '      other:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0(old-orm@1.0.0)',
        'packages:',
        '  needs@1.0.0:',
        '    resolution: {integrity: sha512-n}',
        '    peerDependencies:',
        '      old-orm: ^1.0.0',
        '  other@1.0.0:',
        '    resolution: {integrity: sha512-x}',
        '  old-orm@1.0.0:',
        '    resolution: {integrity: sha512-o}',
        'snapshots:',
        '  needs@1.0.0(old-orm@1.0.0):',
        '    dependencies:',
        '      old-orm: 1.0.0',
        '  other@1.0.0(old-orm@1.0.0):',
        '    dependencies:',
        '      needs: 1.0.0(old-orm@1.0.0)',
        '  old-orm@1.0.0: {}',
        '',
      ].join('\n'),
      'pnpm-lock.yaml',
    );
    expect(edges(lock)).toEqual({
      'cfg@1.0.0': [],
      'needs@1.0.0': ['old-orm@1.0.0'],
      'other@1.0.0': ['needs@1.0.0'],
      'old-orm@1.0.0': [],
    });
    expect(targets(lock)).toEqual({ '.': { needs: 'needs@1.0.0', other: 'other@1.0.0' } });
    expect(lock.configDependencies?.cfg?.target).toBe('cfg@1.0.0');
  });

  it('pnpm: зависимости snapshot не отображением имён на версии — отказ, а не пропуск ребра', () => {
    const text = [
      "lockfileVersion: '9.0'",
      'packages:',
      '  a@1.0.0:',
      '    resolution: {integrity: sha512-a}',
      'snapshots:',
      '  a@1.0.0:',
      '    dependencies:',
      '      - b',
      '',
    ].join('\n');
    expect(() => ParsePnpmLock.parse(text, 'pnpm-lock.yaml')).toThrow(InputUnreadableError);
    expect(() => ParsePnpmLock.parse(text, 'pnpm-lock.yaml')).toThrow('ожидалось отображение имён на версии');
  });

  it('npm: поиск как у node (вложенная копия перекрывает корневую), peer — только установленный, ссылка — зависимости цели', () => {
    const lock = ParseNpmLock.parse(
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { workspaces: ['packages/*'], dependencies: { kit: '^1.0.0' } },
          'node_modules/kit': {
            version: '1.0.0',
            dependencies: { b: '^2.0.0' },
            peerDependencies: { absent: '1' },
          },
          'node_modules/kit/node_modules/b': {
            version: '2.0.0',
            optionalDependencies: { 'old-orm': '^1.0.0' },
          },
          'node_modules/b': { version: '1.0.0' },
          'node_modules/old-orm': { version: '1.0.0', optional: true },
          'node_modules/app': { resolved: 'packages/app', link: true },
          'packages/app': { name: 'app', version: '1.0.0', dependencies: { b: '^1.0.0', own: '1.0.0' } },
          'packages/app/node_modules/own': { version: '1.0.0', peerDependencies: { 'old-orm': '^1.0.0' } },
        },
      }),
      'package-lock.json',
    );
    expect(edges(lock)).toEqual({
      'node_modules/kit': ['node_modules/kit/node_modules/b'],
      'node_modules/kit/node_modules/b': ['node_modules/old-orm'],
      'node_modules/b': [],
      'node_modules/old-orm': [],
      'node_modules/app': ['node_modules/b', 'packages/app/node_modules/own'],
      'packages/app/node_modules/own': ['node_modules/old-orm'],
    });
    expect(targets(lock)).toEqual({
      '.': { kit: 'node_modules/kit' },
      'packages/app': { b: 'node_modules/b', own: 'packages/app/node_modules/own' },
    });
  });

  it('yarn 1: блоки dependencies и optionalDependencies (scope в кавычках, алиас), прочие блоки — не рёбра', () => {
    const lock = ParseYarnLock.parse(
      [
        '# yarn lockfile v1',
        '',
        'kit@^1.0.0:',
        '  version "1.0.0"',
        '  dependencies:',
        '    "@s/b" "^2.0.0"',
        '    db "npm:old-orm@^1.0.0"',
        '  optionalDependencies:',
        '    opt "1.0.0"',
        '  peerDependencies:',
        '    absent "^1.0.0"',
        '',
        '"@s/b@^2.0.0":',
        '  version "2.0.0"',
        '',
        '"db@npm:old-orm@^1.0.0":',
        '  version "1.0.0"',
        '',
        'opt@1.0.0:',
        '  version "1.0.0"',
        '',
      ].join('\n'),
      'yarn.lock',
    );
    expect(edges(lock)).toEqual({
      'kit@^1.0.0': ['@s/b@^2.0.0', 'db@npm:old-orm@^1.0.0', 'opt@1.0.0'],
      '@s/b@^2.0.0': [],
      'db@npm:old-orm@^1.0.0': [],
      'opt@1.0.0': [],
    });
    expect(lock.packages.map((pkg) => pkg.name)).toEqual(['kit', '@s/b', 'old-orm', 'opt']);
  });

  it('yarn 1: неразобранная строка блока зависимостей — отказ со строкой', () => {
    const text = [
      '# yarn lockfile v1',
      '',
      'kit@^1.0.0:',
      '  version "1.0.0"',
      '  dependencies:',
      '    b',
    ].join('\n');
    expect(() => ParseYarnLock.parse(text, 'yarn.lock')).toThrow('dependencies: строка не разобрана: b');
  });

  it('yarn 2+: дескриптор с привязкой ::locator=, зависимость на проект workspace — не ребро и не цель', () => {
    const lock = ParseYarnBerryLock.parse(
      [
        '__metadata:',
        '  version: 8',
        '  cacheKey: 10c0',
        '',
        '"root@workspace:.":',
        '  version: 0.0.0-use.local',
        '  resolution: "root@workspace:."',
        '  dependencies:',
        '    app: "workspace:packages/app"',
        '    local: "file:./local::locator=root%40workspace%3A."',
        '  languageName: unknown',
        '  linkType: soft',
        '',
        '"app@workspace:packages/app":',
        '  version: 0.0.0-use.local',
        '  resolution: "app@workspace:packages/app"',
        '  languageName: unknown',
        '  linkType: soft',
        '',
        '"local@file:./local::locator=root%40workspace%3A.":',
        '  version: 1.0.0',
        '  resolution: "local@file:./local#./local::hash=abc&locator=root%40workspace%3A."',
        '  dependencies:',
        '    old-orm: "npm:^1.0.0"',
        '    app: "workspace:packages/app"',
        '  languageName: node',
        '  linkType: hard',
        '',
        '"old-orm@npm:^1.0.0":',
        '  version: 1.0.0',
        '  resolution: "old-orm@npm:1.0.0"',
        '  checksum: 10c0/aa',
        '  languageName: node',
        '  linkType: hard',
        '',
      ].join('\n'),
      'yarn.lock',
    );
    expect(edges(lock)).toEqual({
      'local@file:./local::locator=root%40workspace%3A.': ['old-orm@npm:^1.0.0'],
      'old-orm@npm:^1.0.0': [],
    });
    expect(targets(lock)).toEqual({
      '.': { app: undefined, local: 'local@file:./local::locator=root%40workspace%3A.' },
      'packages/app': {},
    });
  });
});
