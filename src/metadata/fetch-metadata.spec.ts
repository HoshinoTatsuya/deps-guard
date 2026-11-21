import { FakeRegistry } from '../testing/fake-registry';
import { RuleContextOf } from '../testing/rule-context-of';
import { FetchMetadata } from './fetch-metadata';

jest.setTimeout(20_000);

describe('FetchMetadata', () => {
  let registry: FakeRegistry;

  beforeEach(async () => {
    registry = await FakeRegistry.start(
      {
        '/ms': {
          time: { '2.1.2': '2019-01-01T00:00:00.000Z', '2.1.3': '2020-12-31T00:00:00.000Z' },
          versions: { '2.1.2': {}, '2.1.3': { scripts: { test: 'x' } } },
        },
        '/@s%2fhooked': {
          time: { '1.0.0': '2026-11-14T00:00:00.000Z' },
          versions: { '1.0.0': { scripts: { postinstall: 'node build.js' } } },
        },
        '/gyp': { time: { '1.0.0': '2020-01-01T00:00:00.000Z' }, versions: { '1.0.0': { gypfile: true } } },
      },
      ['/slow'],
    );
  });

  afterEach(async () => {
    await registry.stop();
  });

  it('только версии дерева; признак скрипта из scripts и gypfile; 404 и зависший — в errors, не в кэш', async () => {
    const result = await FetchMetadata.run({
      registry: registry.url,
      timeoutMs: 300,
      authorization: 'Bearer spec-only',
      packages: [
        RuleContextOf.pkg('ms', '2.1.3'),
        RuleContextOf.pkg('@s/hooked', '1.0.0', {
          kind: 'tarball',
          url: `${registry.url}@s/hooked/-/hooked-1.0.0.tgz`,
        }),
        RuleContextOf.pkg('gyp', '1.0.0'),
        RuleContextOf.pkg('missing', '1.0.0'),
        RuleContextOf.pkg('slow', '1.0.0'),
        RuleContextOf.pkg('g', '1.0.0', { kind: 'git', url: 'https://g/g' }),
      ],
    });
    expect(result.metadata).toEqual({
      ms: {
        time: { '2.1.3': '2020-12-31T00:00:00.000Z' },
        versions: { '2.1.3': { hasInstallScript: false } },
      },
      '@s/hooked': {
        time: { '1.0.0': '2026-11-14T00:00:00.000Z' },
        versions: { '1.0.0': { hasInstallScript: true } },
      },
      gyp: {
        time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        versions: { '1.0.0': { hasInstallScript: true } },
      },
    });
    expect(result.errors).toEqual(['missing: реестр ответил 404', expect.stringMatching(/^slow: /)]);
    expect(new Set(registry.requests.map((request) => request.url))).toEqual(
      new Set(['/ms', '/@s%2fhooked', '/gyp', '/missing', '/slow']),
    );
    expect(new Set(registry.requests.map((request) => request.headers.authorization))).toEqual(
      new Set(['Bearer spec-only']),
    );
  });

  it('версии из lock-файла нет в документе реестра — ошибка, а не пустая запись в кэше', async () => {
    const result = await FetchMetadata.run({
      registry: registry.url,
      timeoutMs: 2000,
      packages: [
        RuleContextOf.pkg('ms', '9.9.9'),
        RuleContextOf.pkg('ms', '2.1.3'),
        RuleContextOf.pkg('gyp', '0.0.1'),
      ],
    });
    expect(result.metadata).toEqual({
      ms: {
        time: { '2.1.3': '2020-12-31T00:00:00.000Z' },
        versions: { '2.1.3': { hasInstallScript: false } },
      },
    });
    expect(result.errors).toEqual([
      expect.stringMatching(/^gyp: в документе реестра нет версий 0\.0\.1/),
      expect.stringMatching(/^ms: в документе реестра нет версий 9\.9\.9/),
    ]);
  });

  it('пакет scope — из своего реестра, архив — из реестра по его адресу; Authorization — только реестру по умолчанию', async () => {
    const corp = await FakeRegistry.start({
      '/@corp%2fx': { time: { '1.0.0': '2021-01-01T00:00:00.000Z' }, versions: { '1.0.0': {} } },
      '/tar': { time: { '1.0.0': '2022-01-01T00:00:00.000Z' }, versions: { '1.0.0': {} } },
    });
    try {
      const result = await FetchMetadata.run({
        registry: registry.url,
        scopeRegistries: { '@corp': corp.url },
        authorization: 'Bearer default-only',
        timeoutMs: 2000,
        packages: [
          RuleContextOf.pkg('@corp/x', '1.0.0'),
          RuleContextOf.pkg('tar', '1.0.0', { kind: 'tarball', url: `${corp.url}tar/-/tar-1.0.0.tgz` }),
          RuleContextOf.pkg('ms', '2.1.3'),
          RuleContextOf.pkg('odd', '1.0.0', { kind: 'tarball', url: 'https://cdn.example/odd.tgz' }),
        ],
      });
      expect(Object.keys(result.metadata).sort()).toEqual(['@corp/x', 'ms', 'tar']);
      expect(result.metadata['@corp/x']?.time).toEqual({ '1.0.0': '2021-01-01T00:00:00.000Z' });
      expect(result.errors).toEqual([
        expect.stringMatching(/^odd@1\.0\.0: адрес архива .* не в раскладке реестра/),
      ]);
      expect(corp.requests.map((request) => [request.url, request.headers.authorization]).sort()).toEqual([
        ['/@corp%2fx', undefined],
        ['/tar', undefined],
      ]);
      expect(registry.requests.map((request) => [request.url, request.headers.authorization])).toEqual([
        ['/ms', 'Bearer default-only'],
      ]);
    } finally {
      await corp.stop();
    }
  });

  it('один пакет из двух реестров — ошибка, а не данные одного из них', async () => {
    const result = await FetchMetadata.run({
      registry: registry.url,
      timeoutMs: 2000,
      packages: [
        RuleContextOf.pkg('ms', '2.1.3'),
        RuleContextOf.pkg('ms', '2.1.2', { kind: 'tarball', url: 'http://127.0.0.1:9/ms/-/ms-2.1.2.tgz' }),
      ],
    });
    expect(result.metadata).toEqual({});
    expect(result.errors).toEqual([expect.stringMatching(/^ms: пакет ставится из нескольких реестров/)]);
    expect(registry.requests).toEqual([]);
  });

  /**
   * Учётка в адресе реестра (`https://user:pass@…` из .npmrc): `fetch` такой
   * адрес не принимает (TypeError на каждый пакет). Учётка не используется и
   * никуда не уходит — Authorization задаётся DEPS_GUARD_REGISTRY_AUTH.
   */
  it('учётка в адресе реестра — запрос без неё, а не TypeError; учётка не попадает в ответ', async () => {
    const withCredentials = registry.url.replace('http://', 'http://user:s3cret@');
    const result = await FetchMetadata.run({
      registry: withCredentials,
      timeoutMs: 2000,
      packages: [RuleContextOf.pkg('ms', '2.1.3')],
    });
    expect(result.errors).toEqual([]);
    expect(result.metadata.ms?.time).toEqual({ '2.1.3': '2020-12-31T00:00:00.000Z' });
    expect(registry.requests.map((request) => [request.url, request.headers.authorization])).toEqual([
      ['/ms', undefined],
    ]);
    const denied = await FetchMetadata.run({
      registry: withCredentials,
      timeoutMs: 2000,
      packages: [RuleContextOf.pkg('missing', '1.0.0')],
    });
    expect(denied.errors).toEqual(['missing: реестр ответил 404']);
    expect(JSON.stringify(denied)).not.toContain('s3cret');
  });

  it('архив scope с %2F в верхнем регистре — в раскладке реестра', async () => {
    const result = await FetchMetadata.run({
      registry: 'http://127.0.0.1:9/',
      timeoutMs: 2000,
      packages: [
        RuleContextOf.pkg('@s/hooked', '1.0.0', {
          kind: 'tarball',
          url: `${registry.url}@s%2Fhooked/-/hooked-1.0.0.tgz`,
        }),
      ],
    });
    expect(result.errors).toEqual([]);
    expect(result.metadata['@s/hooked']?.versions).toEqual({ '1.0.0': { hasInstallScript: true } });
  });
});
