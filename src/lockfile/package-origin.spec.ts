import { PackageOrigin } from './package-origin';

describe('PackageOrigin', () => {
  it.each([
    ['lodash', '4.17.21', { name: 'lodash', range: '4.17.21', aliased: false }],
    ['aa-lib', 'npm:bb-lib@1.0.0', { name: 'bb-lib', range: '1.0.0', aliased: true }],
    ['x', 'npm:@s/real@^2', { name: '@s/real', range: '^2', aliased: true }],
    ['x', 'npm:real', { name: 'real', range: '', aliased: true }],
    ['real', 'npm:real@1.0.0', { name: 'real', range: '1.0.0', aliased: false }],
    ['p', 'jsr:@std/path@^1.0.0', { name: '@jsr/std__path', range: '^1.0.0', aliased: true }],
    ['@std/path', 'jsr:1.0.0', { name: '@jsr/std__path', range: '1.0.0', aliased: true }],
    ['x', 'npm:', { name: 'x', range: 'npm:', aliased: false }],
    ['x', 'npm:@bad@1', { name: 'x', range: 'npm:@bad@1', aliased: false }],
    // Протокол без учёта регистра, как у npm (npm-package-arg): `NPM:` — тоже алиас.
    ['aa-lib', 'NPM:bb-lib@1.0.0', { name: 'bb-lib', range: '1.0.0', aliased: true }],
    ['aa-lib', 'Npm:bb-lib', { name: 'bb-lib', range: '', aliased: true }],
    ['p', 'JSR:@std/path@1.0.0', { name: '@jsr/std__path', range: '1.0.0', aliased: true }],
    ['@std/path', 'Jsr:1.0.0', { name: '@jsr/std__path', range: '1.0.0', aliased: true }],
    ['x', '  npm:y@1  ', { name: 'y', range: '1', aliased: true }],
    // yarn 2+: `npm:` с одним диапазоном — тот же пакет под своим ключом.
    ['x', 'npm:^1.0.0', { name: 'x', range: '^1.0.0', aliased: false }],
    ['x', 'npm:1.2.3', { name: 'x', range: '1.2.3', aliased: false }],
    ['x', 'npm:>=1 <2', { name: 'x', range: '>=1 <2', aliased: false }],
    ['x', 'npm:*', { name: 'x', range: '*', aliased: false }],
    ['x', 'npm:1password@1.0.0', { name: '1password', range: '1.0.0', aliased: true }],
  ])('цель %s: %s', (key, specifier, expected) => {
    expect(PackageOrigin.target(key, specifier)).toEqual(expected);
  });

  it('селектор yarn: ключ, спецификатор и настоящее имя', () => {
    expect(PackageOrigin.ofSelector('lodash@npm:lodahs@1.0.0')).toEqual({
      key: 'lodash',
      specifier: 'npm:lodahs@1.0.0',
      name: 'lodahs',
      range: '1.0.0',
      aliased: true,
    });
    expect(PackageOrigin.ofSelector('@s/a@^1.0.0')).toMatchObject({
      key: '@s/a',
      name: '@s/a',
      range: '^1.0.0',
    });
    expect(PackageOrigin.ofSelector('@scope')).toBeUndefined();
    expect(PackageOrigin.ofSelector('noversion')).toBeUndefined();
  });

  it.each([
    [undefined, { kind: 'registry-default' }],
    ['', { kind: 'registry-default' }],
    [
      'git+ssh://git@github.com/u/r.git#abc',
      { kind: 'git', url: 'git+ssh://git@github.com/u/r.git', commit: 'abc' },
    ],
    ['git+https://github.com/u/r', { kind: 'git', url: 'git+https://github.com/u/r' }],
    [
      'ssh://git@example.com/x/gg.git#main',
      { kind: 'git', url: 'ssh://git@example.com/x/gg.git', commit: 'main' },
    ],
    ['git@github.com:u/r.git#abc', { kind: 'git', url: 'git@github.com:u/r.git', commit: 'abc' }],
    ['github:u/r#abc', { kind: 'git', url: 'github:u/r', commit: 'abc' }],
    ['GIT+HTTPS://github.com/u/r#abc', { kind: 'git', url: 'GIT+HTTPS://github.com/u/r', commit: 'abc' }],
    ['file:x.tgz', { kind: 'file', url: 'file:x.tgz' }],
    ['file:x.TGZ', { kind: 'file', url: 'file:x.TGZ' }],
    ['file:x.tar.gz', { kind: 'file', url: 'file:x.tar.gz' }],
    ['file:./dir', { kind: 'directory', url: 'file:./dir' }],
    ['FILE:./dir', { kind: 'directory', url: 'FILE:./dir' }],
    ['https://r/x.tgz#sha1', { kind: 'tarball', url: 'https://r/x.tgz' }],
    ['HTTPS://r/x.tgz', { kind: 'tarball', url: 'HTTPS://r/x.tgz' }],
    ['http://r/x.tgz', { kind: 'tarball', url: 'http://r/x.tgz' }],
    ['https://r/git+x/-/x.tgz', { kind: 'tarball', url: 'https://r/git+x/-/x.tgz' }],
    ['https://r/x-file:1.tgz', { kind: 'tarball', url: 'https://r/x-file:1.tgz' }],
    ['packages/a', { kind: 'unknown', url: 'packages/a' }],
    ['ftp://r/x.tgz', { kind: 'unknown', url: 'ftp://r/x.tgz' }],
    ['x-https://r/x.tgz', { kind: 'unknown', url: 'x-https://r/x.tgz' }],
  ])('адрес %s', (resolved, expected) => {
    expect(PackageOrigin.fromUrl(resolved)).toEqual(expected);
  });

  it.each([
    ['file:./local', '.', { kind: 'directory', url: 'file:./local' }],
    ['file:vendor/x.tgz', '.', { kind: 'file', url: 'file:vendor/x.tgz' }],
    ['link:./l', '.', { kind: 'link', url: 'l' }],
    ['link:../sibling', 'packages/a', { kind: 'link', url: 'packages/sibling' }],
    ['link:/etc/evil', '.', { kind: 'link', url: '/etc/evil' }],
    ['link:C:\\evil', '.', { kind: 'link', url: 'C:\\evil' }],
    ['^1.0.0', '.', { kind: 'registry-default' }],
    ['npm:real@1.0.0', '.', { kind: 'registry-default' }],
    ['https://r/x.tgz', '.', { kind: 'tarball', url: 'https://r/x.tgz' }],
    ['portal:./x', '.', { kind: 'unknown', url: 'portal:./x' }],
    ['LINK:./l', '.', { kind: 'link', url: 'l' }],
    ['NPM:real@1.0.0', '.', { kind: 'registry-default' }],
    ['jsr:@std/path@1', '.', { kind: 'registry-default' }],
    ['latest', '.', { kind: 'registry-default' }],
    ['>=1 <2', '.', { kind: 'registry-default' }],
    ['~1.2.3', '.', { kind: 'registry-default' }],
    ['workspace:*', '.', { kind: 'unknown', url: 'workspace:*' }],
    ['catalog:', '.', { kind: 'unknown', url: 'catalog:' }],
    ['./vendor/x', '.', { kind: 'directory', url: 'file:./vendor/x' }],
    ['../x.tgz', '.', { kind: 'file', url: 'file:../x.tgz' }],
    ['/abs/x', '.', { kind: 'directory', url: 'file:/abs/x' }],
    ['~/x', '.', { kind: 'directory', url: 'file:~/x' }],
    ['C:\\x', '.', { kind: 'directory', url: 'file:C:\\x' }],
    ['a/b/c', '.', { kind: 'directory', url: 'file:a/b/c' }],
    ['x.tgz', '.', { kind: 'file', url: 'file:x.tgz' }],
    ['evil/repo', '.', { kind: 'git', url: 'github:evil/repo' }],
    ['evil/repo#abc', '.', { kind: 'git', url: 'github:evil/repo', commit: 'abc' }],
    [
      'ssh://git@h.example/r.git#main',
      '.',
      { kind: 'git', url: 'ssh://git@h.example/r.git', commit: 'main' },
    ],
    ['git@h.example:u/r.git', '.', { kind: 'git', url: 'git@h.example:u/r.git' }],
    ['gist:abc', '.', { kind: 'git', url: 'gist:abc' }],
    ['ftp://r/x.tgz', '.', { kind: 'unknown', url: 'ftp://r/x.tgz' }],
  ])('спецификатор без адреса %s (проект %s)', (specifier, importer, expected) => {
    expect(PackageOrigin.fromSpecifier(specifier, importer)).toEqual(expected);
  });

  it('абсолютный путь ссылки остаётся абсолютным (POSIX, диск Windows, UNC)', () => {
    expect(PackageOrigin.linkTarget('.', '/etc/evil')).toBe('/etc/evil');
    expect(PackageOrigin.linkTarget('packages/a', '/etc/evil')).toBe('/etc/evil');
    expect(PackageOrigin.linkTarget('.', 'C:/evil')).toBe('C:/evil');
    expect(PackageOrigin.linkTarget('.', '\\\\server\\share')).toBe('\\\\server\\share');
    expect(PackageOrigin.linkTarget('packages/a', '../b')).toBe('packages/b');
    expect(PackageOrigin.linkTarget('.', '../outside')).toBe('../outside');
    expect([
      PackageOrigin.isAbsolute('/x'),
      PackageOrigin.isAbsolute('C:\\x'),
      PackageOrigin.isAbsolute('c:x'),
      PackageOrigin.isAbsolute('x/y'),
    ]).toEqual([true, true, true, false]);
  });

  /**
   * yarn 1 считает git-адресом и `https://…/x.git[#…]` без `git+` и пишет в
   * yarn.lock `resolved "https://хост/x.git#<коммит>"` (GitResolver: `${url}#${commit}`).
   */
  it('https://…/x.git#коммит (yarn 1) — git с коммитом, а не архив', () => {
    expect(PackageOrigin.fromUrl('https://git.example/team/x.git#0123abc')).toEqual({
      kind: 'git',
      url: 'https://git.example/team/x.git',
      commit: '0123abc',
    });
    expect(PackageOrigin.fromUrl('https://git.example/team/x.git')).toEqual({
      kind: 'git',
      url: 'https://git.example/team/x.git',
    });
    expect(PackageOrigin.fromUrl('https://r.example/x/-/x-1.0.0.tgz#sha1')).toEqual({
      kind: 'tarball',
      url: 'https://r.example/x/-/x-1.0.0.tgz',
    });
  });
});
