import { symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import { TempDir } from '../testing/temp-dir';
import { WorkspaceDirs } from './workspace-dirs';

const DIRS = [
  'packages/a',
  'packages/b',
  'packages/b/test/fixture',
  'packages/@scope/c',
  'packages/.hidden',
  'apps/web',
  'apps/web/node_modules/dep',
  'tools/deep/nested/x',
  'docs',
];

describe('WorkspaceDirs', () => {
  it.each([
    [['packages/*'], ['packages/a', 'packages/b']],
    [['packages/**'], ['packages/a', 'packages/b', 'packages/@scope/c']],
    [['packages/@scope/*'], ['packages/@scope/c']],
    [['./apps/*/'], ['apps/web']],
    [['**'], ['packages/a', 'packages/b', 'packages/@scope/c', 'apps/web', 'tools/deep/nested/x', 'docs']],
    [['packages/?'], ['packages/a', 'packages/b']],
    [['packages/*', '!packages/b'], ['packages/a']],
    [['tools/**/x'], ['tools/deep/nested/x']],
    [['.', 'docs'], ['docs']],
  ])('pnpm %j', (patterns, expected) => {
    expect(WorkspaceDirs.match('pnpm', patterns, DIRS)).toEqual(expected);
  });

  it('у npm и yarn test/ не исключается, node_modules — всегда', () => {
    expect(WorkspaceDirs.match('yarn', ['packages/**'], DIRS)).toEqual([
      'packages/a',
      'packages/b',
      'packages/b/test/fixture',
      'packages/@scope/c',
    ]);
    expect(WorkspaceDirs.match('npm', ['apps/**'], DIRS)).toEqual(['apps/web']);
  });

  it('шаблоны: pnpm — packages, npm и yarn — workspaces (массив или { packages })', () => {
    expect(WorkspaceDirs.patterns('pnpm', { workspaces: ['x/*'] }, { packages: ['p/*'] })).toEqual(['p/*']);
    expect(WorkspaceDirs.patterns('npm', { workspaces: ['x/*'] }, { packages: ['p/*'] })).toEqual(['x/*']);
    expect(
      WorkspaceDirs.patterns('yarn', { workspaces: { packages: ['y/*'], nohoist: ['**'] } }, {}),
    ).toEqual(['y/*']);
    expect(WorkspaceDirs.patterns('yarn', {}, {})).toEqual([]);
  });

  it.each([
    ['{a,b}', ['packages/{a,b}']],
    ['[ab]', ['packages/[ab]']],
    ['extglob', ['packages/@(a|b)']],
    ['не список', 'packages/*'],
    ['не строка', [1]],
    ['пустой', ['']],
  ])('шаблон вне подмножества (%s) — отказ, а не «ничего не совпало»', (_name, workspaces) => {
    expect(() => WorkspaceDirs.patterns('npm', { workspaces }, {})).toThrow(InputUnreadableError);
  });

  it('на диске: каталоги с package.json, со скрытыми (как в списке файлов git), без node_modules и .git', () => {
    const dir = TempDir.create({
      'package.json': '{}',
      'packages/a/package.json': '{}',
      'packages/b/readme.md': 'x',
      'packages/b/inner/package.json': '{}',
      'node_modules/x/package.json': '{}',
      '.git/y/package.json': '{}',
      '.cache/y/package.json': '{}',
    });
    try {
      expect(WorkspaceDirs.onDisk(dir)).toEqual({
        dirs: ['.cache/y', 'packages/a', 'packages/b/inner'],
        unread: [],
      });
    } finally {
      TempDir.remove(dir);
    }
    expect(WorkspaceDirs.fromFiles(['package.json', 'packages/a/package.json', 'packages/a/x.json'])).toEqual(
      ['packages/a'],
    );
  });

  it.each([
    ['выход из корня', '../x/*'],
    ['абсолютный путь', '/abs/*'],
    ['диск Windows', 'C:/x/*'],
    ['обратный слэш', 'packages\\*'],
    ['выход из корня в исключении', '!../x'],
  ])('шаблон %s — отказ', (_name, pattern) => {
    expect(() => WorkspaceDirs.patterns('npm', { workspaces: [pattern] }, {})).toThrow(InputUnreadableError);
  });

  it('явный сегмент на «.» заходит в скрытый каталог, «*» и «**» — нет', () => {
    const dirs = ['.tools/a', 'packages/.x', 'packages/a'];
    expect(WorkspaceDirs.match('yarn', ['.tools/*'], dirs)).toEqual(['.tools/a']);
    expect(WorkspaceDirs.match('yarn', ['**'], dirs)).toEqual(['packages/a']);
    expect(WorkspaceDirs.match('yarn', ['packages/.x'], dirs)).toEqual(['packages/.x']);
  });

  it('каталог-ссылка и каталог глубже MAX_DEPTH — «не прочитано», если до них дотягивается шаблон', () => {
    const deep = Array.from({ length: WorkspaceDirs.MAX_DEPTH + 1 }, (_, i) => `d${i}`).join('/');
    const dir = TempDir.create({
      'package.json': '{}',
      'real/p/package.json': '{}',
      [`${deep}/package.json`]: '{}',
    });
    try {
      symlinkSync(join(dir, 'real'), join(dir, 'linked'));
      const disk = WorkspaceDirs.onDisk(dir);
      expect(disk.unread).toEqual([
        deep
          .split('/')
          .slice(0, WorkspaceDirs.MAX_DEPTH + 1)
          .join('/'),
        'linked',
      ]);
      expect(disk.dirs).toEqual(['real/p']);
      expect(WorkspaceDirs.reachable('pnpm', ['linked/*'], disk.unread)).toEqual(['linked']);
      expect(WorkspaceDirs.reachable('pnpm', ['**'], disk.unread)).toEqual(disk.unread);
      expect(WorkspaceDirs.reachable('pnpm', ['real/*', 'd0/x/*'], disk.unread)).toEqual([]);
      expect(WorkspaceDirs.reachable('pnpm', ['!linked/*'], disk.unread)).toEqual([]);
    } finally {
      TempDir.remove(dir);
    }
  });
});
