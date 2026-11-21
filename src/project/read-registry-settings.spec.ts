import { InputUnreadableError } from '../input-unreadable.error';
import { TempDir } from '../testing/temp-dir';
import { ReadRegistrySettings } from './read-registry-settings';

describe('ReadRegistrySettings', () => {
  let dir: string;

  beforeEach(() => {
    dir = TempDir.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  it('registry и @scope:registry из .npmrc — со scope, путём и строкой; прочие ключи (токены) — нет', () => {
    TempDir.write(dir, {
      '.npmrc': [
        '//r.example/:_authToken=npm_SECRET',
        'registry=https://r.example/',
        '@corp:registry=https://corp.example/',
        'x@corp:registry=https://evil.example/',
        '@corp:registryX=https://evil.example/',
        '@corp:registry:extra=https://evil.example/',
        'registry-x=https://evil.example/',
        '',
      ].join('\n'),
    });
    expect(ReadRegistrySettings.read(dir, 'npm')).toEqual([
      { key: 'registry', scope: undefined, value: 'https://r.example/', path: '.npmrc', line: 2 },
      { key: '@corp:registry', scope: '@corp', value: 'https://corp.example/', path: '.npmrc', line: 3 },
    ]);
  });

  it('.yarnrc читается только для yarn', () => {
    TempDir.write(dir, {
      '.yarnrc': 'registry "https://y.example/"\n',
      '.npmrc': 'registry=https://n.example/\n',
    });
    expect(ReadRegistrySettings.read(dir, 'npm').map((entry) => entry.path)).toEqual(['.npmrc']);
    expect(ReadRegistrySettings.read(dir, 'pnpm').map((entry) => entry.path)).toEqual(['.npmrc']);
    expect(ReadRegistrySettings.read(dir, 'yarn').map((entry) => [entry.path, entry.value])).toEqual([
      ['.npmrc', 'https://n.example/'],
      ['.yarnrc', 'https://y.example/'],
    ]);
  });

  it('yarn 2+: реестры только из .yarnrc.yml (npmRegistryServer, npmScopes); .npmrc и .yarnrc он не читает', () => {
    TempDir.write(dir, {
      '.npmrc': 'registry=https://n.example/\n',
      '.yarnrc': 'registry "https://y.example/"\n',
      '.yarnrc.yml':
        'npmRegistryServer: "https://b.example/"\nnpmScopes:\n  corp:\n    npmRegistryServer: "https://corp.example/"\n    npmAlwaysAuth: true\n  plain:\n    npmAlwaysAuth: true\n',
    });
    expect(ReadRegistrySettings.read(dir, 'yarn-berry')).toEqual([
      {
        key: 'npmRegistryServer',
        scope: undefined,
        value: 'https://b.example/',
        path: '.yarnrc.yml',
        line: 1,
      },
      {
        key: 'npmScopes.corp.npmRegistryServer',
        scope: '@corp',
        value: 'https://corp.example/',
        path: '.yarnrc.yml',
        line: 4,
      },
    ]);
  });

  it.each([
    ['пустой адрес', 'npmRegistryServer:\n'],
    ['npmScopes не отображение', 'npmScopes: [a]\n'],
    ['scope не отображение', 'npmScopes:\n  corp: x\n'],
  ])('yarn 2+: %s — отказ', (_name, text) => {
    TempDir.write(dir, { '.yarnrc.yml': text });
    expect(() => ReadRegistrySettings.read(dir, 'yarn-berry')).toThrow(InputUnreadableError);
  });
});
