import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeRegistry } from '../testing/fake-registry';
import { GitRepo } from '../testing/git-repo';
import { GreenProject } from '../testing/green-project';
import { RunBin } from '../testing/run-bin';
import { TempDir } from '../testing/temp-dir';

jest.setTimeout(90_000);

interface SarifLog {
  runs: Array<{ results: Array<{ ruleId: string; properties: { subject: string; verdict: string } }> }>;
}

/**
 * Сквозной прогон собранного CLI во временном git-репозитории с настоящими
 * lock-файлами pnpm 12: база — коммит с двумя зависимостями, рабочее дерево —
 * проект с новыми (реестровая с плавающим диапазоном, два локальных каталога,
 * один — с postinstall).
 */
describe('deps-guard check — сквозной прогон в git-репозитории', () => {
  let dir: string;
  let base: string;

  beforeEach(() => {
    dir = TempDir.create();
    GitRepo.init(dir);
    TempDir.copyFixture('pnpm-project/base', dir);
    base = GitRepo.commitAll(dir, 'база: debug и ms');
    TempDir.copyFixture('pnpm-project/head', dir);
    const config = GreenProject.config();
    TempDir.write(dir, {
      'deps-guard.json': JSON.stringify(
        {
          ...config,
          newDependencies: { baseline: { gitRef: 'main' }, allow: { semver: GreenProject.REASON } },
          sources: { ...config.sources, allow: { 'plain-lib@file:vendor/plain-lib': GreenProject.REASON } },
          floatingRanges: {},
        },
        null,
        2,
      ),
    });
    const metadata = GreenProject.metadata(dir);
    metadata.semver = {
      time: { '7.8.6': '2026-11-13T00:00:00.000Z' },
      versions: { '7.8.6': { hasInstallScript: false } },
    };
    TempDir.write(dir, { 'deps-guard.metadata.json': JSON.stringify(metadata, null, 2) });
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  const check = (...extra: string[]) =>
    RunBin.run(dir, ['check', '--base', base, '--now', GreenProject.NOW.toISOString(), ...extra]);

  it('нарушения: код 1, SARIF с ровно ожидаемыми находками, текст в журнал', async () => {
    const result = await check('--format', 'sarif', '--out', 'deps-guard.sarif');
    expect(result.stderr).toBe('');
    expect(result.code).toBe(1);
    const sarif = JSON.parse(readFileSync(join(dir, 'deps-guard.sarif'), 'utf8')) as SarifLog;
    const found = sarif.runs[0]?.results.map(
      (item) => `${item.ruleId}|${item.properties.verdict}|${item.properties.subject}`,
    );
    expect(new Set(found)).toEqual(
      new Set([
        'new-dependency|violation|native-hook@file:vendor/native-hook',
        'new-dependency|violation|plain-lib@file:vendor/plain-lib',
        'source|violation|native-hook@file:vendor/native-hook',
        'freshness|violation|semver@7.8.6',
        'floating-range|violation|semver',
      ]),
    );
    expect(found).toHaveLength(5);
    expect(result.stdout).toContain(
      'Итог: нарушений 5, устарело 0, не проверено 0, не прочитано 0, созрело допусков 0 (удалите их, код не меняют) → код 1',
    );
  });

  it('исправленный проект — код 0; JUnit без failure и error', async () => {
    const config = JSON.parse(readFileSync(join(dir, 'deps-guard.json'), 'utf8')) as Record<
      string,
      Record<string, unknown>
    >;
    TempDir.write(dir, {
      'deps-guard.json': JSON.stringify({
        ...config,
        newDependencies: {
          baseline: { gitRef: 'main' },
          allow: GreenProject.config().newDependencies?.allow,
        },
        sources: GreenProject.config().sources,
        floatingRanges: GreenProject.config().floatingRanges,
        freshness: {
          metadataFile: 'deps-guard.metadata.json',
          allow: { 'semver@7.8.6': GreenProject.REASON },
        },
      }),
    });
    const result = await check('--format', 'junit');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('tests="9" failures="0" errors="0" skipped="0"');
    expect(result.stdout).not.toMatch(/<failure|<error/);
  });

  it('нет даты публикации — код 2 (не проверено), а не 0', async () => {
    const metadata = JSON.parse(readFileSync(join(dir, 'deps-guard.metadata.json'), 'utf8')) as Record<
      string,
      object
    >;
    delete metadata.ms;
    writeFileSync(join(dir, 'deps-guard.metadata.json'), JSON.stringify(metadata));
    const config = JSON.parse(readFileSync(join(dir, 'deps-guard.json'), 'utf8')) as Record<string, unknown>;
    TempDir.write(dir, {
      'deps-guard.json': JSON.stringify({
        ...config,
        ...GreenProject.config(),
        newDependencies: {
          baseline: { gitRef: 'main' },
          allow: GreenProject.config().newDependencies?.allow,
        },
        freshness: {
          metadataFile: 'deps-guard.metadata.json',
          allow: { 'semver@7.8.6': GreenProject.REASON },
        },
      }),
    });
    const result = await check('--format', 'json');
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout) as { findings: Array<{ rule: string; verdict: string }> };
    expect(report.findings.map((finding) => `${finding.rule}|${finding.verdict}`).sort()).toEqual([
      'freshness|unverified',
      'install-script|unverified',
    ]);
  });

  it('package.json разошёлся с lock-файлом — нарушение lock-mismatch', async () => {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    manifest.dependencies.ms = '2.1.2';
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
    const result = await check('--format', 'json');
    const report = JSON.parse(result.stdout) as { findings: Array<{ rule: string; subject: string }> };
    expect(report.findings.filter((finding) => finding.rule === 'lock-mismatch')).toEqual([
      expect.objectContaining({ rule: 'lock-mismatch', subject: 'ms' }),
    ]);
  });

  it('неверный вызов и неизвестная база — код 2 с причиной', async () => {
    expect((await RunBin.run(dir, ['check', '--format', 'xml'])).code).toBe(2);
    expect((await RunBin.run(dir, ['nope'])).stderr).toContain('неизвестная команда');
    const unknownBase = await RunBin.run(dir, ['check', '--base', 'нет-такой-ветки', '--format', 'json']);
    const report = JSON.parse(unknownBase.stdout) as { findings: Array<{ rule: string; verdict: string }> };
    expect(report.findings).toContainEqual(
      expect.objectContaining({ rule: 'new-dependency', verdict: 'broken' }),
    );
  });

  it('baseline пишет прямые зависимости; metadata выгружает из реестра и сливает с кэшем', async () => {
    const baseline = await RunBin.run(dir, ['baseline', '--out', 'base.json']);
    expect(baseline.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8'))).toEqual({
      dependencies: [
        'debug',
        'ms',
        'native-hook@file:vendor/native-hook',
        'plain-lib@file:vendor/plain-lib',
        'semver',
      ],
    });
    const registry = await FakeRegistry.start({
      '/ms': { time: { '2.1.3': '2020-12-31T00:00:00.000Z' }, versions: { '2.1.3': {} } },
    });
    try {
      TempDir.write(dir, {
        'meta.json': JSON.stringify({ kept: { time: { '1.0.0': '2000-01-01T00:00:00Z' } } }),
      });
      const fetched = await RunBin.run(
        dir,
        ['metadata', '--registry', registry.url, '--out', 'meta.json', '--timeout-ms', '2000'],
        { DEPS_GUARD_REGISTRY_AUTH: 'Bearer spec-only' },
      );
      expect(fetched.code).toBe(2);
      expect(fetched.stderr).toContain('debug: реестр ответил 404');
      const cache = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(cache)).toEqual(['kept', 'ms']);
      expect(registry.requests.every((request) => request.headers.authorization === 'Bearer spec-only')).toBe(
        true,
      );
      // Абсолютный --out — как есть, а не под корнем (прежде join склеивал его с корнем).
      const elsewhere = TempDir.create();
      try {
        const absolute = await RunBin.run(dir, [
          'metadata',
          '--registry',
          registry.url,
          '--out',
          join(elsewhere, 'meta.json'),
          '--timeout-ms',
          '2000',
        ]);
        expect(absolute.stdout).toContain('записано');
        expect(Object.keys(JSON.parse(readFileSync(join(elsewhere, 'meta.json'), 'utf8')))).toEqual(['ms']);
      } finally {
        TempDir.remove(elsewhere);
      }
    } finally {
      await registry.stop();
    }
  });
});
