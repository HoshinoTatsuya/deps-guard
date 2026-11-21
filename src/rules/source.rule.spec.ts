import { RuleContextOf } from '../testing/rule-context-of';
import { TempDir } from '../testing/temp-dir';
import type { LockedPackage } from '../types/locked-package.type';
import { SourceRule } from './source.rule';

const REASON = 'форк с исправлением, которое ещё не вошло в выпуск автора';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const STRONG = `sha512-${'A'.repeat(86)}==`;
const REGISTRIES = ['https://registry.npmjs.org/', 'http://npm.internal.example/npm/'];

const run = (
  packages: LockedPackage[],
  sources: Record<string, unknown> = {},
): Array<[string, string, string]> =>
  SourceRule.run(
    RuleContextOf.make({
      lock: RuleContextOf.lock(packages),
      config: {
        sources: { registries: REGISTRIES, defaultRegistry: 'https://registry.npmjs.org/', ...sources },
      },
    }),
  ).findings.map((finding) => [finding.verdict, finding.subject, finding.reason]);

describe('SourceRule', () => {
  it('реестр по умолчанию и архивы разрешённых реестров — без находок', () => {
    expect(
      run([
        RuleContextOf.pkg('a', '1.0.0'),
        RuleContextOf.pkg('b', '1.0.0', {
          kind: 'tarball',
          url: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz',
        }),
        RuleContextOf.pkg('c', '1.0.0', {
          kind: 'tarball',
          url: 'http://npm.internal.example/npm/c/-/c-1.0.0.tgz',
        }),
        RuleContextOf.pkg(
          'ws',
          'link:packages/ws',
          { kind: 'link', url: 'packages/ws' },
          { integrity: undefined },
        ),
      ]),
    ).toEqual([]);
  });

  it.each([
    ['хост-продолжение', 'https://registry.npmjs.org.evil.example/x/-/x-1.tgz'],
    ['учётка в адресе', 'https://user:pw@registry.npmjs.org/x/-/x-1.tgz'],
    ['токен без пароля в адресе', 'https://token@registry.npmjs.org/x/-/x-1.tgz'],
    ['соседний путь', 'http://npm.internal.example/npm-evil/x-1.tgz'],
    ['другая схема', 'http://registry.npmjs.org/x/-/x-1.tgz'],
    ['чужой хост', 'https://codeload.github.com/u/x/tar.gz/main'],
    ['закодированный «/» в пути', 'http://npm.internal.example/npm/..%2Fevil/x-1.tgz'],
    ['закодированный «\\» в пути', 'http://npm.internal.example/npm/..%5cevil/x-1.tgz'],
  ])('архив не из реестра (%s) — нарушение; учётка из адреса в сообщение не попадает', (_name, url) => {
    const findings = run([RuleContextOf.pkg('x', '1.0.0', { kind: 'tarball', url })]);
    expect(findings).toEqual([
      ['violation', 'x@1.0.0', expect.stringMatching(/^архив не из разрешённого реестра: /)],
    ]);
    expect(findings[0]?.[2]).not.toMatch(/pw@|token@/);
  });

  it('точка в конце имени хоста — тот же реестр', () => {
    expect(
      run([
        RuleContextOf.pkg('x', '1.0.0', { kind: 'tarball', url: 'https://registry.npmjs.org./x/-/x-1.tgz' }),
      ]),
    ).toEqual([]);
  });

  it('пакет из bundleDependencies — без своего адреса и integrity, судится с родителем', () => {
    expect(
      run([
        RuleContextOf.pkg(
          'inner',
          '1.0.0',
          { kind: 'bundled', url: 'node_modules/a' },
          { integrity: undefined },
        ),
      ]),
    ).toEqual([]);
  });

  it('ссылка: каталог «..x» внутри репозитория — не наружу; диск Windows — наружу', () => {
    expect(
      run([
        RuleContextOf.pkg('in', 'link:..x/y', { kind: 'link', url: '..x/y' }, { integrity: undefined }),
        RuleContextOf.pkg('win', 'link:C:/x', { kind: 'link', url: 'C:/x' }, { integrity: undefined }),
        RuleContextOf.pkg('up', 'link:..', { kind: 'link', url: '..' }, { integrity: undefined }),
      ]).map(([verdict, subject]) => [verdict, subject]),
    ).toEqual([
      ['violation', 'win@link:C:/x'],
      ['violation', 'up@link:..'],
    ]);
  });

  it('реестр установки из .npmrc проекта: вне списка — нарушение; из переменной — не проверено; токены не читаются', () => {
    const dir = TempDir.create({
      '.npmrc': [
        '//evil.example/:_authToken=секрет-токена',
        'registry=https://evil.example/',
        '@corp:registry=http://npm.internal.example/npm/',
        `@env:registry=${'$'}{CORP_REGISTRY}`,
        '',
      ].join('\n'),
    });
    try {
      const outcome = SourceRule.run(
        RuleContextOf.make({
          root: dir,
          lock: RuleContextOf.lock([RuleContextOf.pkg('a', '1.0.0'), RuleContextOf.pkg('@corp/b', '1.0.0')]),
          config: { sources: { registries: REGISTRIES } },
        }),
      );
      expect(
        outcome.findings.map((finding) => [finding.verdict, finding.subject, finding.path, finding.line]),
      ).toEqual([
        ['violation', 'registry', '.npmrc', 2],
        ['unverified', '@env:registry', '.npmrc', 4],
      ]);
      expect(JSON.stringify(outcome)).not.toContain('секрет');
    } finally {
      TempDir.remove(dir);
    }
  });

  it('реестр по scope и по умолчанию: пакет без адреса судится по своему реестру установки', () => {
    const dir = TempDir.create({ '.npmrc': '@corp:registry=https://evil.example/\n' });
    try {
      const outcome = SourceRule.run(
        RuleContextOf.make({
          root: dir,
          lock: RuleContextOf.lock([RuleContextOf.pkg('plain', '1.0.0')]),
          config: { sources: { registries: REGISTRIES } },
        }),
      );
      expect(outcome.findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
        ['violation', '@corp:registry'],
        ['unverified', '1 пакетов'],
      ]);
    } finally {
      TempDir.remove(dir);
    }
  });

  it('yarn: реестр из .yarnrc тоже реестр установки', () => {
    const dir = TempDir.create({ '.yarnrc': 'registry "https://evil.example/"\n' });
    try {
      const findings = SourceRule.run(
        RuleContextOf.make({
          root: dir,
          lock: RuleContextOf.lock([], { kind: 'yarn', path: 'yarn.lock' }),
          config: { sources: { registries: REGISTRIES } },
        }),
      ).findings;
      expect(findings.map((finding) => [finding.verdict, finding.subject, finding.path])).toEqual([
        ['violation', 'registry', '.yarnrc'],
      ]);
    } finally {
      TempDir.remove(dir);
    }
  });

  /**
   * yarn 1 при `registry` в обоих файлах берёт `.yarnrc` (проба: `yarn config get
   * registry` 1.22.22). Порядок чтения на вердикт не влияет: каждая запись
   * судится против sources.registries сама, а из списка берётся лишь «задан ли
   * реестр»; `deps-guard metadata` берёт последнюю — `.yarnrc`.
   */
  it('yarn: registry в .npmrc и .yarnrc — судится каждый, чужой назван в своём файле при любом порядке', () => {
    for (const [npmrc, yarnrc, bad] of [
      [REGISTRIES[0], 'https://evil.example/', '.yarnrc'],
      ['https://evil.example/', REGISTRIES[0], '.npmrc'],
    ] as const) {
      const dir = TempDir.create({ '.npmrc': `registry=${npmrc}\n`, '.yarnrc': `registry "${yarnrc}"\n` });
      try {
        const findings = SourceRule.run(
          RuleContextOf.make({
            root: dir,
            lock: RuleContextOf.lock([], { kind: 'yarn', path: 'yarn.lock' }),
            config: { sources: { registries: REGISTRIES } },
          }),
        ).findings;
        expect(findings.map((finding) => [finding.verdict, finding.subject, finding.path])).toEqual([
          ['violation', 'registry', bad],
        ]);
      } finally {
        TempDir.remove(dir);
      }
    }
  });

  it('git, file, directory, ссылка наружу, нераспознанный — нарушение без допуска', () => {
    const findings = run([
      RuleContextOf.pkg(
        'g',
        '1.0.0',
        { kind: 'git', url: 'https://github.com/u/g', commit: SHA },
        { integrity: undefined },
      ),
      RuleContextOf.pkg('f', '1.0.0', { kind: 'file', url: 'file:vendor/f.tgz' }),
      RuleContextOf.pkg(
        'd',
        'file:vendor/d',
        { kind: 'directory', url: 'vendor/d' },
        { integrity: undefined },
      ),
      RuleContextOf.pkg('l', 'link:../out', { kind: 'link', url: '../out' }, { integrity: undefined }),
      RuleContextOf.pkg('u', '1.0.0', { kind: 'unknown', url: 'type: variations' }),
    ]);
    expect(findings.map(([verdict, subject]) => [verdict, subject])).toEqual([
      ['violation', 'g@1.0.0'],
      ['violation', 'f@1.0.0'],
      ['violation', 'd@file:vendor/d'],
      ['violation', 'l@link:../out'],
      ['violation', 'u@1.0.0'],
    ]);
  });

  it('допуск источника: git с коммитом — без находки; git без коммита — нарушение; допуск integrity не отменяет', () => {
    const findings = run(
      [
        RuleContextOf.pkg(
          'g',
          '1.0.0',
          { kind: 'git', url: 'https://github.com/u/g', commit: SHA },
          { integrity: undefined },
        ),
        RuleContextOf.pkg(
          'h',
          '1.0.0',
          { kind: 'git', url: 'https://github.com/u/h', commit: 'main' },
          { integrity: undefined },
        ),
        RuleContextOf.pkg('f', '1.0.0', { kind: 'file', url: 'file:vendor/f.tgz' }, { integrity: undefined }),
      ],
      {
        allow: {
          'g@https://github.com/u/g': REASON,
          'h@https://github.com/u/h': REASON,
          'f@file:vendor/f.tgz': REASON,
        },
      },
    );
    expect(findings).toEqual([
      ['violation', 'h@1.0.0', 'git-зависимость не закреплена коммитом (40 hex)'],
      ['violation', 'f@1.0.0', expect.stringContaining('нет integrity')],
    ]);
  });

  it('нет integrity и только sha1 — нарушения; sha1 рядом с sha512 — нет', () => {
    const findings = run([
      RuleContextOf.pkg('none', '1.0.0', { kind: 'registry-default' }, { integrity: undefined }),
      RuleContextOf.pkg('weak', '1.0.0', { kind: 'registry-default' }, { integrity: 'sha1-abc=' }),
      RuleContextOf.pkg('both', '1.0.0', { kind: 'registry-default' }, { integrity: `sha1-abc= ${STRONG}` }),
    ]);
    expect(findings.map(([, subject, reason]) => [subject, reason.slice(0, 18)])).toEqual([
      ['none@1.0.0', 'нет integrity: сод'],
      ['weak@1.0.0', 'integrity только s'],
    ]);
  });

  it.each([
    ['sha512 без хэша', 'sha512-'],
    ['sha512 с обрезанным хэшем', 'sha512-AAAA'],
    ['sha512 с хэшем длины sha256', `sha512-${'A'.repeat(43)}=`],
    ['sha256 с хэшем длины sha512', `sha256-${'A'.repeat(86)}==`],
    ['не base64', `sha512-${'!'.repeat(86)}==`],
    ['лишние знаки после хэша', `sha512-${'A'.repeat(86)}==x`],
    [
      'base64 без дополнения (не каноническая запись — сравнение строкой не сойдётся)',
      `sha512-${'A'.repeat(86)}`,
    ],
    ['только пробелы', '   '],
    ['мусорный токен рядом с пустым', 'sha512- garbage'],
  ])('integrity без корректного сильного токена (%s) — нарушение', (_name, integrity) => {
    const findings = run([RuleContextOf.pkg('x', '1.0.0', { kind: 'registry-default' }, { integrity })]);
    expect(findings).toEqual([['violation', 'x@1.0.0', expect.stringMatching(/integrity/)]]);
  });

  it.each([
    ['sha512', STRONG],
    ['sha384', `sha384-${'A'.repeat(64)}`],
    ['sha256', `sha256-${'A'.repeat(43)}=`],
    ['с опциями SRI', `${STRONG}?foo`],
    ['рядом с мусором', `garbage sha512- ${STRONG}`],
  ])('корректный сильный токен (%s) — без находки', (_name, integrity) => {
    expect(run([RuleContextOf.pkg('x', '1.0.0', { kind: 'registry-default' }, { integrity })])).toEqual([]);
  });

  it('допуск источника — по адресу: тот же пакет с другого адреса допуском не покрыт', () => {
    const pkg = (url: string) =>
      RuleContextOf.pkg('g', '1.0.0', { kind: 'git', url, commit: SHA }, { integrity: undefined });
    const allow = { allow: { 'g@https://github.com/u/g': REASON } };
    expect(run([pkg('https://github.com/u/g')], allow)).toEqual([]);
    expect(run([pkg('https://evil.example/u/g')], allow)).toEqual([
      ['violation', 'g@1.0.0', expect.stringContaining('sources.allow["g@https://evil.example/u/g"]')],
      ['stale', 'sources.allow["g@https://github.com/u/g"]', expect.stringContaining('устарело')],
    ]);
    expect(run([pkg('https://github.com/u/g')], { allow: { g: REASON } })).toEqual([
      ['violation', 'g@1.0.0', expect.stringContaining('не реестр')],
      ['stale', 'sources.allow["g"]', expect.stringContaining('устарело')],
    ]);
  });

  it('предмет допуска — без учётки из адреса', () => {
    const findings = run([
      RuleContextOf.pkg('x', '1.0.0', { kind: 'tarball', url: 'https://user:pw@evil.example/x.tgz' }),
    ]);
    expect(findings[0]?.[2]).toContain('sources.allow["x@https://evil.example/x.tgz"]');
    expect(findings[0]?.[2]).not.toMatch(/pw/);
    const ssh = run([
      RuleContextOf.pkg(
        's',
        '1.0.0',
        { kind: 'git', url: 'ssh://git@g.example/u/s.git', commit: SHA },
        { integrity: undefined },
      ),
    ]);
    expect(ssh[0]?.[2]).toContain('sources.allow["s@ssh://git@g.example/u/s.git"]');
  });

  it('без defaultRegistry пакеты без адреса — не проверено одной находкой; реестр по умолчанию вне списка — нарушение', () => {
    const packages = [RuleContextOf.pkg('a', '1.0.0'), RuleContextOf.pkg('b', '1.0.0')];
    const unverified = SourceRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock(packages),
        config: { sources: { registries: REGISTRIES } },
      }),
    );
    expect(unverified.findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['unverified', '2 пакетов'],
    ]);
    const outside = SourceRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock(packages),
        config: { sources: { registries: REGISTRIES, defaultRegistry: 'https://mirror.example/' } },
      }),
    );
    expect(outside.findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['violation', 'sources.defaultRegistry'],
    ]);
  });

  it('реестр без «/» в конце: соседний путь с тем же началом не проходит', () => {
    const findings = SourceRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock([
          RuleContextOf.pkg('ok', '1.0.0', {
            kind: 'tarball',
            url: 'http://npm.internal.example/npm/ok/-/ok-1.0.0.tgz',
          }),
          RuleContextOf.pkg('evil', '1.0.0', {
            kind: 'tarball',
            url: 'http://npm.internal.example/npm-evil/x-1.tgz',
          }),
        ]),
        config: { sources: { registries: ['http://npm.internal.example/npm'] } },
      }),
    ).findings;
    expect(findings.map((finding) => finding.subject)).toEqual(['evil@1.0.0']);
  });

  it('пустой список реестров — ни один архив не разрешён', () => {
    const findings = SourceRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock([
          RuleContextOf.pkg('b', '1.0.0', { kind: 'tarball', url: 'https://registry.npmjs.org/b.tgz' }),
        ]),
        config: {},
      }),
    ).findings;
    expect(findings.map((finding) => finding.verdict)).toEqual(['violation']);
  });

  it('допуск пакета из реестра — устарело', () => {
    expect(run([RuleContextOf.pkg('a', '1.0.0')], { allow: { a: REASON } })).toEqual([
      ['stale', 'sources.allow["a"]', expect.stringContaining('устарело')],
    ]);
  });

  describe('yarn 2+: checksum', () => {
    const HEX = 'b'.repeat(128);
    const berry = (integrity: string | undefined, conditions?: string) =>
      SourceRule.run(
        RuleContextOf.make({
          lock: RuleContextOf.lock(
            [RuleContextOf.pkg('x', '1.0.0', { kind: 'registry-default' }, { integrity, conditions })],
            { kind: 'yarn-berry', path: 'yarn.lock', cacheKey: '10c0' },
          ),
          config: { sources: { registries: REGISTRIES, defaultRegistry: 'https://registry.npmjs.org/' } },
        }),
      ).findings.map((finding) => finding.reason);

    it.each([
      ['без префикса', HEX],
      ['с префиксом текущего cacheKey', `10c0/${HEX}`],
    ])('%s — без находки', (_name, checksum) => {
      expect(berry(checksum)).toEqual([]);
    });

    it.each([
      ['нет', undefined, /^нет checksum: yarn не сверяет/],
      ['пустой', '', /^нет checksum/],
      ['префикс чужого cacheKey', `9/${HEX}`, /префиксом «9»/],
      ['обрезанный', 'b'.repeat(127), /не sha512/],
      ['SRI вместо hex', `sha512-${'A'.repeat(86)}==`, /не sha512/],
      ['верхний регистр', 'B'.repeat(128), /не sha512/],
    ])('%s — нарушение', (_name, checksum, reason) => {
      expect(berry(checksum)).toEqual([expect.stringMatching(reason)]);
    });

    it('пакет платформы без checksum — нарушение с подсказкой про supportedArchitectures', () => {
      expect(berry(undefined, 'os=linux & cpu=x64')).toEqual([
        expect.stringContaining('supportedArchitectures'),
      ]);
    });
  });
});
