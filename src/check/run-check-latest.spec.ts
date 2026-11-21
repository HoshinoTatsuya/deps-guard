import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TempDir } from '../testing/temp-dir';
import type { CheckReport } from '../types/check-report.type';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import type { PackageMetadata } from '../types/package-metadata.type';
import { RunCheck } from './run-check';

/**
 * Последние версии менеджеров (17.11.2026): lock-файлы записаны настоящими npm
 * 12.2.2, yarn 1.22.22 и pnpm 12.21.0 с реестра npm (fixtures/latest). У pnpm
 * — `packageManager: pnpm@12.21.0` (lock-файл с документом окружения: сам
 * pnpm и 15 его сборок) и `es5-ext` с postinstall; метаданные — выгрузка
 * реестра (`deps-guard metadata`); у npm и yarn — метаданные заданы в спеке
 * (старые даты, без скриптов). Решения pnpm — замер на pnpm 12.21.0
 * (`pnpm permissions`, маркер postinstall).
 */
const NOW = new Date('2026-11-17T00:00:00Z');
const NPMJS = 'https://registry.npmjs.org/';
const LATEST = join(TempDir.FIXTURES, 'latest');
const SMALL: Record<string, PackageMetadata> = {
  'is-number': {
    time: { '7.0.0': '2018-07-04T15:08:58.238Z' },
    versions: { '7.0.0': { hasInstallScript: false } },
  },
  ms: { time: { '2.1.3': '2020-12-08T13:54:35.223Z' }, versions: { '2.1.3': { hasInstallScript: false } } },
};

describe('RunCheck: последние версии менеджеров', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      TempDir.remove(dir);
    }
  });

  const project = (fixture: string, files: Record<string, string> = {}): string => {
    const dir = TempDir.create();
    dirs.push(dir);
    TempDir.copyFixture(join('latest', fixture), dir);
    TempDir.write(dir, {
      'base.json': JSON.stringify({ dependencies: ['is-number', 'ms', 'es5-ext'] }),
      ...files,
    });
    return dir;
  };

  const config = (extra: DepsGuardConfig = {}): DepsGuardConfig => ({
    newDependencies: { baseline: { file: 'base.json' } },
    sources: { registries: [NPMJS, 'https://registry.yarnpkg.com/'], defaultRegistry: NPMJS },
    floatingRanges: { fields: [] },
    freshness: { minAgeDays: 1 },
    ...extra,
  });

  const lines = (report: CheckReport): string[] =>
    report.findings.map((finding) => `${finding.rule}|${finding.verdict}|${finding.subject}|${finding.path}`);

  it('npm 12.2.2 (lockfile v3): все правила прочитали, запрет скриптов не подтверждён — единственная находка', () => {
    const report = RunCheck.run({ root: project('npm-12.2.2'), config: config(), metadata: SMALL, now: NOW });
    expect(lines(report)).toEqual(['install-script|unverified|installScripts.othersBlockedBy|package.json']);
    expect(report.rules.find((rule) => rule.rule === 'source')?.checked).toBe(2);
    expect(report.rules.find((rule) => rule.rule === 'lock-mismatch')?.checked).toBe(2);
  });

  it('yarn 1.22.22: все правила прочитали; ignore-scripts в .yarnrc — чисто', () => {
    const report = RunCheck.run({
      root: project('yarn-1.22.22', { '.yarnrc': 'ignore-scripts true\n' }),
      config: config(),
      metadata: SMALL,
      now: NOW,
    });
    expect(lines(report)).toEqual([]);
    expect(report.rules.find((rule) => rule.rule === 'source')?.checked).toBe(2);
  });

  describe('pnpm 12.21.0', () => {
    const metadata = JSON.parse(
      readFileSync(join(LATEST, 'pnpm-12.21.0', 'metadata.json'), 'utf8'),
    ) as Record<string, PackageMetadata>;
    const scripts = (workspace: string, packageManager = 'pnpm@12.21.0'): string[] => {
      const json = JSON.parse(readFileSync(join(LATEST, 'pnpm-12.21.0', 'package.json'), 'utf8'));
      const report = RunCheck.run({
        root: project('pnpm-12.21.0', {
          'pnpm-workspace.yaml': workspace,
          'package.json': JSON.stringify({ ...json, packageManager }),
        }),
        config: config(),
        metadata,
        now: NOW,
      });
      return report.findings
        .filter((finding) => finding.rule === 'install-script')
        .map((finding) => `${finding.verdict}|${finding.subject}|${finding.reason}`);
    };

    it('allowBuilds: false + permissions.build: true (pnpm: «Granted») — решение; сам pnpm из packageManagerDependencies — не находка', () => {
      expect(scripts(readFileSync(join(LATEST, 'pnpm-12.21.0', 'pnpm-workspace.yaml'), 'utf8'))).toEqual([]);
    });

    it('только permissions.build (true или false) — решение, а не «скрипт без решения»', () => {
      expect(scripts('permissions:\n  es5-ext:\n    build: true\n')).toEqual([]);
      expect(scripts('permissions:\n  es5-ext:\n    build: false\n')).toEqual([]);
    });

    it('без решения — нарушение у es5-ext и только у него (pnpm@12.21.0 и @pnpm/exe.* — самоустановка pnpm)', () => {
      expect(scripts('')).toEqual([
        'violation|es5-ext@0.10.64|install-скрипт без решения: allowBuilds (true — разрешить, false — запретить) или installScripts.allow с причиной',
      ]);
    });

    it('permissions.build строкой («true», заглушка) — решения нет', () => {
      expect(scripts('permissions:\n  es5-ext:\n    build: "true"\n')).toEqual([
        'violation|es5-ext@0.10.64|install-скрипт без решения: allowBuilds (true — разрешить, false — запретить) или installScripts.allow с причиной; не читаются этой версией: pnpm-workspace.yaml: permissions.es5-ext.build = «true» — решения нет (нужно true или false)',
      ]);
    });

    it('pnpm 12.10 permissions не читает (замер: «not recognized», скрипт не выполнен) — нарушение с названным ключом', () => {
      expect(scripts('permissions:\n  es5-ext:\n    build: true\n', 'pnpm@12.10.1')).toEqual([
        'violation|es5-ext@0.10.64|install-скрипт без решения: allowBuilds (true — разрешить, false — запретить) или installScripts.allow с причиной; не читаются этой версией: pnpm-workspace.yaml: permissions (pnpm 12.10 его не читает — нужен 12.11+)',
      ]);
    });
  });
});
