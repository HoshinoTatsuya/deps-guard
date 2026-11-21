import { InputUnreadableError } from '../input-unreadable.error';
import { ConfigDependencies } from './config-dependencies';
import { PnpmWorkspace } from './pnpm-workspace';

describe('ConfigDependencies', () => {
  const of = (text: string) => ConfigDependencies.of(PnpmWorkspace.parse(text));

  it('имя, спецификатор и строка каждой записи', () => {
    expect(of("allowBuilds: {}\nconfigDependencies:\n  a: '1.0.0+sha512-x'\n  '@s/b': 2.0.0\n")).toEqual([
      { name: 'a', specifier: '1.0.0+sha512-x', line: 3 },
      { name: '@s/b', specifier: '2.0.0', line: 4 },
    ]);
  });

  it('нет раздела, пустой раздел, нет файла — пусто', () => {
    expect(of('allowBuilds: {}\n')).toEqual([]);
    expect(of('configDependencies:\n')).toEqual([]);
    expect(of('configDependencies: {}\n')).toEqual([]);
    expect(ConfigDependencies.of(undefined)).toEqual([]);
  });

  it('строка записи без номера — без поля line (flow-запись)', () => {
    expect(of("configDependencies: {a: '1.0.0'}\n")).toEqual([{ name: 'a', specifier: '1.0.0' }]);
  });

  it.each([
    ['список', 'configDependencies:\n  - a\n'],
    ['строка', 'configDependencies: a\n'],
    ['не строка в значении', 'configDependencies:\n  a: 1\n  b: {x: 1}\n'],
    ['булево в значении', 'configDependencies:\n  a: true\n'],
  ])('%s — отказ с путём и строкой раздела', (_name, text) => {
    let error: unknown;
    try {
      ConfigDependencies.of(PnpmWorkspace.parse(text), 'база:pnpm-workspace.yaml');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InputUnreadableError);
    expect((error as InputUnreadableError).path).toBe('база:pnpm-workspace.yaml');
    expect((error as InputUnreadableError).line).toBe(1);
  });
});
