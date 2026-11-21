import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitRepo } from '../testing/git-repo';
import { TempDir } from '../testing/temp-dir';
import type { CheckReport } from '../types/check-report.type';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import type { PackageMetadata } from '../types/package-metadata.type';
import { RunCheck } from './run-check';

/**
 * yarn.lock форматов 8, 9 и 10: один проект (npm, алиас, `catalog:`, `exec:`
 * с `built: true`, git, `patch:`, link, file, portal, адрес архива,
 * workspace, пакет платформы), записанный настоящим yarn 4.13.0, 4.14.1 и
 * 4.18.1 (fixtures/yarn-berry-project/formats) с поддельным реестром и git на
 * 127.0.0.1. Модель — замер на тех же yarn по маркерам скриптов:
 *
 * - 4.13.0: postinstall обоих пакетов, `exec:` и prepack git выполнены;
 * - 4.14.1 и 4.18.1 без `enableScripts`: postinstall не выполнен, `exec:` —
 *   только с `built: true`, prepack git — выполнен (при любых enableScripts
 *   и dependenciesMeta; git — только из `approvedGitRepositories`).
 */
const NOW = new Date('2026-11-17T00:00:00Z');
const REGISTRY = 'http://127.0.0.1:48721/';
const REASON = 'проверено вручную: источник и назначение пакета известны';
const HOOKED: PackageMetadata = {
  time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
  versions: { '1.0.0': { hasInstallScript: true } },
};
const PLAIN: PackageMetadata = {
  time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
  versions: { '1.0.0': { hasInstallScript: false } },
};
const METADATA = {
  'hook-a': HOOKED,
  'hook-b': HOOKED,
  'aa-lib': PLAIN,
  'bb-lib': PLAIN,
  'plat-win': PLAIN,
  tarball: PLAIN,
  localtgz: PLAIN,
};
const FORMATS = ['v8-yarn-4.13.0', 'v9-yarn-4.14.1', 'v10-yarn-4.18.1'] as const;
type Format = (typeof FORMATS)[number];

describe('RunCheck: yarn.lock форматов 8, 9, 10 (настоящий yarn 4.13.0, 4.14.1, 4.18.1)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      TempDir.remove(dir);
    }
  });

  const project = (format: Format, files: Record<string, string> = {}): string => {
    const dir = TempDir.create();
    dirs.push(dir);
    TempDir.copyFixture(join('yarn-berry-project', 'formats', format), dir);
    TempDir.write(dir, files);
    return dir;
  };

  const fixtureText = (format: Format, file: string): string =>
    readFileSync(join(TempDir.FIXTURES, 'yarn-berry-project', 'formats', format, file), 'utf8');

  const config = (extra: DepsGuardConfig = {}): DepsGuardConfig => ({
    sources: {
      registries: [REGISTRY],
      defaultRegistry: REGISTRY,
      allow: {
        'gen@exec:./gen.js': REASON,
        'gitprep@git://127.0.0.1:19418/gitprep': REASON,
        'local-dir@file:local-dir': REASON,
        'localtgz@file:aa.tgz': REASON,
        'portal-dir@file:portal-dir': REASON,
      },
    },
    floatingRanges: { fields: [] },
    ...extra,
  });

  const check = (dir: string, extra: DepsGuardConfig = {}): CheckReport =>
    RunCheck.run({ root: dir, config: config(extra), metadata: METADATA, now: NOW });

  const of = (report: CheckReport, rule: string): string[] =>
    report.findings
      .filter((finding) => finding.rule === rule)
      .map((finding) => `${finding.verdict}|${finding.subject}|${finding.path}`);

  it.each(FORMATS)(
    '%s читается всеми правилами: ни одного «не прочитано», catalog: — не висячая',
    (format) => {
      const report = check(project(format));
      expect(report.findings.filter((finding) => finding.verdict === 'broken')).toEqual([]);
      expect(of(report, 'lock-mismatch')).toEqual([]);
      expect(report.rules.find((rule) => rule.rule === 'source')?.checked).toBe(13);
    },
  );

  it('формат 8 (yarn 4.13.0): скрипты всех выполняются — hook-a, hook-b, exec: и git без решения, запрет остальных не подтверждён', () => {
    expect(of(check(project('v8-yarn-4.13.0')), 'install-script')).toEqual([
      'unverified|installScripts.othersBlockedBy|package.json',
      'violation|gen@1.0.0|yarn.lock',
      'violation|gitprep@1.0.0|yarn.lock',
      'violation|hook-a@1.0.0|yarn.lock',
      'violation|hook-b@1.0.0|yarn.lock',
    ]);
  });

  it.each(['v9-yarn-4.14.1', 'v10-yarn-4.18.1'] as const)(
    '%s без enableScripts: остальные запрещены умолчанием; exec: с built: true — решение; prepack git — нарушение',
    (format) => {
      expect(of(check(project(format)), 'install-script')).toEqual(['violation|gitprep@1.0.0|yarn.lock']);
      expect(
        of(check(project(format), { installScripts: { allow: { gitprep: REASON } } }), 'install-script'),
      ).toEqual([]);
    },
  );

  it('формат 10: exec: без built: true не исполняется (yarn отказывает) — не находка; формат 8 — исполняется', () => {
    const manifest = (format: Format): string => {
      const json = JSON.parse(fixtureText(format, 'package.json'));
      delete json.dependenciesMeta.gen;
      return JSON.stringify(json);
    };
    expect(
      of(
        check(project('v10-yarn-4.18.1', { 'package.json': manifest('v10-yarn-4.18.1') })),
        'install-script',
      ),
    ).toEqual(['violation|gitprep@1.0.0|yarn.lock']);
    expect(
      of(check(project('v8-yarn-4.13.0', { 'package.json': manifest('v8-yarn-4.13.0') })), 'install-script'),
    ).toContain('violation|gen@1.0.0|yarn.lock');
  });

  it('формат 10 с enableScripts: true — скрипты всех: hook-a и hook-b без решения, запрет остальных не подтверждён', () => {
    const report = check(
      project('v10-yarn-4.18.1', {
        '.yarnrc.yml': `${fixtureText('v10-yarn-4.18.1', '.yarnrc.yml')}enableScripts: true\n`,
      }),
    );
    expect(of(report, 'install-script')).toEqual([
      'unverified|installScripts.othersBlockedBy|.yarnrc.yml',
      'violation|gitprep@1.0.0|yarn.lock',
      'violation|hook-a@1.0.0|yarn.lock',
      'violation|hook-b@1.0.0|yarn.lock',
    ]);
    expect(
      report.findings.find((finding) => finding.subject === 'installScripts.othersBlockedBy')?.reason,
    ).toContain('yarn 4.14+ с enableScripts: true');
  });

  it('формат 10 с enableImmutableInstalls: false — формат поколение yarn не доказывает: как формат 8', () => {
    const report = check(
      project('v10-yarn-4.18.1', {
        '.yarnrc.yml': `${fixtureText('v10-yarn-4.18.1', '.yarnrc.yml')}enableImmutableInstalls: false\n`,
      }),
    );
    expect(of(report, 'install-script')).toEqual([
      'unverified|installScripts.othersBlockedBy|package.json',
      'violation|gen@1.0.0|yarn.lock',
      'violation|gitprep@1.0.0|yarn.lock',
      'violation|hook-a@1.0.0|yarn.lock',
      'violation|hook-b@1.0.0|yarn.lock',
    ]);
    expect(report.findings.find((finding) => finding.subject === 'hook-a@1.0.0')?.reason).toContain(
      'enableImmutableInstalls false',
    );
  });

  it('git: enableScripts: false и built: false prepack не останавливают — нарушение во всех форматах', () => {
    for (const format of FORMATS) {
      const json = JSON.parse(fixtureText(format, 'package.json'));
      json.dependenciesMeta.gitprep = { built: false };
      const report = check(
        project(format, {
          '.yarnrc.yml': `${fixtureText(format, '.yarnrc.yml')}enableScripts: false\n`,
          'package.json': JSON.stringify(json),
        }),
      );
      expect(of(report, 'install-script')).toEqual([
        ...(format === 'v8-yarn-4.13.0' ? ['violation|gen@1.0.0|yarn.lock'] : []),
        'violation|gitprep@1.0.0|yarn.lock',
      ]);
      expect(report.findings.find((finding) => finding.subject === 'gitprep@1.0.0')?.reason).toContain(
        'prepack git-зависимости yarn исполняет при любых enableScripts и dependenciesMeta',
      );
    }
  });

  describe('catalog: (yarn 4.10+, каталог в .yarnrc.yml)', () => {
    it('диапазон судится по каталогу .yarnrc.yml: «^1.0.0» — плавающий', () => {
      const report = check(project('v10-yarn-4.18.1'), { floatingRanges: { fields: ['dependencies'] } });
      // packages/ws объявляет «^1.0.0» напрямую — тоже плавающий.
      expect(of(report, 'floating-range')).toEqual([
        'violation|bb-lib|package.json',
        'violation|bb-lib|packages/ws/package.json',
      ]);
      expect(report.findings.find((finding) => finding.rule === 'floating-range')?.reason).toBe(
        'плавающий диапазон «catalog:» → catalog: «^1.0.0» (caret, dependencies): закрепите точную версию',
      );
    });

    it('записи в каталоге нет — спецификатор не разобран и зависимость висячая', () => {
      const yarnrc = fixtureText('v10-yarn-4.18.1', '.yarnrc.yml').replace(
        'catalog:\n  bb-lib: ^1.0.0\n',
        '',
      );
      const report = check(project('v10-yarn-4.18.1', { '.yarnrc.yml': yarnrc }), {
        floatingRanges: { fields: ['dependencies'] },
      });
      expect(of(report, 'lock-mismatch')).toEqual(['violation|bb-lib|yarn.lock']);
      expect(report.findings.find((finding) => finding.rule === 'floating-range')?.reason).toBe(
        'спецификатор «catalog:» → в .yarnrc.yml нет catalog.bb-lib не разобран (dependencies)',
      );
    });

    it('каталог указывает на диапазон, которого в yarn.lock нет, — висячая', () => {
      const yarnrc = fixtureText('v10-yarn-4.18.1', '.yarnrc.yml').replace(
        'bb-lib: ^1.0.0',
        'bb-lib: ^2.0.0',
      );
      expect(of(check(project('v10-yarn-4.18.1', { '.yarnrc.yml': yarnrc })), 'lock-mismatch')).toEqual([
        'violation|bb-lib|yarn.lock',
      ]);
    });

    it.each([
      ['«^1.0.0» в базе, «catalog:» сейчас', '^1.0.0', 'catalog:'],
      ['«catalog:» в базе (каталог .yarnrc.yml базы), «^1.0.0» сейчас', 'catalog:', '^1.0.0'],
    ])('новая зависимость: %s — тот же пакет, не новая', (_name, before, after) => {
      const dir = project('v10-yarn-4.18.1');
      const json = JSON.parse(fixtureText('v10-yarn-4.18.1', 'package.json'));
      // bb-lib в базе держат ещё алиас корня (`npm:bb-lib@1.0.0`) и packages/ws — их убираем, чтобы
      // пакет держала только проверяемая запись `catalog:`/«^1.0.0».
      const { alias: _alias, ...dependencies } = json.dependencies;
      const manifest = (range: string): string =>
        JSON.stringify({ ...json, dependencies: { ...dependencies, 'bb-lib': range } });
      const ws = JSON.parse(fixtureText('v10-yarn-4.18.1', 'packages/ws/package.json'));
      delete ws.dependencies['bb-lib'];
      TempDir.write(dir, {
        'package.json': manifest(before),
        'packages/ws/package.json': JSON.stringify(ws),
      });
      GitRepo.init(dir);
      const base = GitRepo.commitAll(dir, 'база');
      TempDir.write(dir, { 'package.json': manifest(after) });
      const report = RunCheck.run({
        root: dir,
        config: config({ newDependencies: { baseline: { gitRef: base } } }),
        metadata: METADATA,
        now: NOW,
      });
      expect(report.findings.filter((finding) => finding.rule === 'new-dependency')).toEqual([]);
      expect(report.rules.find((rule) => rule.rule === 'new-dependency')?.checked).toBeGreaterThan(10);
    });
  });
});
