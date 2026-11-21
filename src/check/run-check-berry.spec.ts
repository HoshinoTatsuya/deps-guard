import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DepsGuard } from '../deps-guard';
import { ExitCodeOf } from '../report/exit-code-of';
import { RenderReport } from '../report/render-report';
import { GitRepo } from '../testing/git-repo';
import { TempDir } from '../testing/temp-dir';
import type { CheckReport } from '../types/check-report.type';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import type { PackageMetadata } from '../types/package-metadata.type';
import { RunCheck } from './run-check';

/**
 * Проекты yarn 2+ (berry): lock-файлы и настройки записаны настоящим yarn
 * 4.0.2 (fixtures/yarn-berry-project) с поддельным реестром на 127.0.0.1.
 * Модель скриптов — замер на том же yarn: по умолчанию выполняются скрипты
 * всех пакетов, `dependenciesMeta.<пакет>.built: false` запрещает,
 * `enableScripts: false` запрещает остальные, а `built: true` разрешает и при
 * нём; `exec:` исполняется всегда.
 */
const NOW = new Date('2026-11-16T00:00:00Z');
const REASON = 'проверено вручную: источник и назначение пакета известны';
const REGISTRY = 'http://127.0.0.1:48721/';
const HOOKED: PackageMetadata = {
  time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
  versions: { '1.0.0': { hasInstallScript: true } },
};
const FIXTURES = join(TempDir.FIXTURES, 'yarn-berry-project');

describe('RunCheck: yarn 2+', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      TempDir.remove(dir);
    }
  });

  const project = (fixture: 'scripts' | 'protocols', files: Record<string, string> = {}): string => {
    const dir = TempDir.create();
    dirs.push(dir);
    TempDir.copyFixture(join('yarn-berry-project', fixture), dir);
    TempDir.write(dir, {
      'base.json': JSON.stringify({ dependencies: ['hook-a', 'hook-b', 'aa-lib', 'ws'] }),
      ...files,
    });
    return dir;
  };

  const config = (extra: DepsGuardConfig = {}): DepsGuardConfig => ({
    newDependencies: { baseline: { file: 'base.json' } },
    sources: { registries: [REGISTRY], defaultRegistry: REGISTRY },
    floatingRanges: { fields: [] },
    ...extra,
  });

  const check = (dir: string, extra: DepsGuardConfig = {}): CheckReport =>
    RunCheck.run({
      root: dir,
      config: config(extra),
      metadata: { 'hook-a': HOOKED, 'hook-b': HOOKED },
      now: NOW,
    });

  const of = (report: CheckReport, rule: string): string[] =>
    report.findings
      .filter((finding) => finding.rule === rule)
      .map((finding) => `${finding.verdict}|${finding.subject}|${finding.path}`);

  const yarnrc = (extra: string): string =>
    `${readFileSync(join(FIXTURES, 'scripts', '.yarnrc.yml'), 'utf8')}${extra}`;

  const manifest = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      ...JSON.parse(readFileSync(join(FIXTURES, 'scripts', 'package.json'), 'utf8')),
      ...extra,
    });

  it('согласованный проект с настройкой, запрещающей скрипты, — код 0: все правила прочитали berry', () => {
    const report = check(project('scripts', { '.yarnrc.yml': yarnrc('enableScripts: false\n') }));
    expect(report.findings).toEqual([]);
    expect(report.rules.find((rule) => rule.rule === 'source')?.checked).toBe(2);
    expect(report.rules.find((rule) => rule.rule === 'lock-mismatch')?.checked).toBe(2);
    expect(ExitCodeOf.report(report)).toBe(0);
  });

  it('по умолчанию yarn выполняет скрипты всех: пакет со скриптом без решения — нарушение, запрет остальных — не проверено', () => {
    const report = check(project('scripts'));
    expect(of(report, 'install-script')).toEqual([
      'unverified|installScripts.othersBlockedBy|package.json',
      'violation|hook-a@1.0.0|yarn.lock',
      'violation|hook-b@1.0.0|yarn.lock',
    ]);
    expect(report.findings.find((finding) => finding.subject === 'hook-a@1.0.0')?.reason).toContain(
      'dependenciesMeta["hook-a"].built',
    );
  });

  it('dependenciesMeta built: false — решение; built: true при enableScripts: false — решение', () => {
    expect(
      of(
        check(
          project('scripts', {
            'package.json': manifest({ dependenciesMeta: { 'hook-a@1.0.0': { built: false } } }),
          }),
        ),
        'install-script',
      ),
    ).toEqual(['unverified|installScripts.othersBlockedBy|package.json', 'violation|hook-b@1.0.0|yarn.lock']);
    expect(
      of(
        check(
          project('scripts', {
            '.yarnrc.yml': yarnrc('enableScripts: false\n'),
            'package.json': manifest({ dependenciesMeta: { 'hook-a': { built: true } } }),
          }),
        ),
        'install-script',
      ),
    ).toEqual([]);
  });

  it('ignore-scripts в .npmrc и .yarnrc yarn 2+ не читает — не запрет', () => {
    const report = check(
      project('scripts', { '.npmrc': 'ignore-scripts=true\n', '.yarnrc': 'ignore-scripts true\n' }),
    );
    expect(of(report, 'install-script')).toContain('violation|hook-a@1.0.0|yarn.lock');
  });

  it('checksum: префикс чужого cacheKey и checksumBehavior: ignore — нарушения (yarn такой архив не сверяет)', () => {
    const lock = readFileSync(join(FIXTURES, 'scripts', 'yarn.lock'), 'utf8').replace(
      'checksum: 1eb',
      'checksum: 9/1eb',
    );
    const report = check(
      project('scripts', {
        'yarn.lock': lock,
        '.yarnrc.yml': yarnrc('enableScripts: false\nchecksumBehavior: ignore\n'),
      }),
    );
    expect(of(report, 'source')).toEqual([
      'violation|checksumBehavior|.yarnrc.yml',
      'violation|hook-a@1.0.0|yarn.lock',
    ]);
    expect(report.findings.find((finding) => finding.subject === 'hook-a@1.0.0')?.reason).toContain(
      'префиксом «9»',
    );
  });

  it('реестр установки — из .yarnrc.yml (вне списка — нарушение); реестр .npmrc yarn 2+ не читает', () => {
    const report = check(
      project('scripts', {
        '.yarnrc.yml': 'npmRegistryServer: "https://evil.example/"\nenableScripts: false\n',
        '.npmrc': 'registry=https://other.example/\n',
      }),
    );
    expect(of(report, 'source')).toEqual(['violation|npmRegistryServer|.yarnrc.yml']);
  });

  it('package.json разошёлся с yarn.lock — нарушение согласованности; новая зависимость — new-dependency', () => {
    const report = check(
      project('scripts', {
        '.yarnrc.yml': yarnrc('enableScripts: false\n'),
        'package.json': manifest({ dependencies: { 'hook-a': '1.0.1', 'hook-b': '1.0.0', fresh: '1.0.0' } }),
      }),
    );
    expect(of(report, 'lock-mismatch')).toEqual([
      'violation|hook-a|package.json',
      'violation|fresh|package.json',
    ]);
    expect(of(report, 'new-dependency')).toEqual(['violation|fresh|package.json']);
  });

  it('протоколы: exec: — нераспознанный источник и скрипт при любой настройке; файлы и порталы — не реестр; workspace и согласованность — чисто', () => {
    const report = check(project('protocols'), {
      installScripts: { othersBlockedBy: REASON },
    });
    expect(of(report, 'install-script')).toEqual(['violation|gen@1.0.0|yarn.lock']);
    expect(of(report, 'source')).toEqual([
      'violation|gen@1.0.0|yarn.lock',
      'violation|local-dir@1.0.0|yarn.lock',
      'violation|localtgz@1.0.0|yarn.lock',
      'violation|portal-dir@0.0.0-use.local|yarn.lock',
    ]);
    expect(of(report, 'lock-mismatch')).toEqual([]);
    expect(report.findings.filter((finding) => finding.verdict === 'broken')).toEqual([]);
  });

  describe('.yarnrc.yml: yarnPath, plugins, packageExtensions — относительно базы', () => {
    const toolchain = (files: Record<string, string>): { dir: string; base: string } => {
      const dir = project('scripts', {
        '.yarnrc.yml': yarnrc('enableScripts: false\nyarnPath: .yarn/releases/yarn.cjs\n'),
        '.yarn/releases/yarn.cjs': 'выпуск yarn',
      });
      GitRepo.init(dir);
      const base = GitRepo.commitAll(dir, 'база');
      TempDir.write(dir, files);
      return { dir, base };
    };
    const newDeps = (dir: string, base: string, allow: Record<string, string> = {}): string[] =>
      RunCheck.run({
        root: dir,
        config: config({ newDependencies: { baseline: { gitRef: base }, allow } }),
        metadata: { 'hook-a': HOOKED, 'hook-b': HOOKED },
        now: NOW,
      })
        .findings.filter((finding) => finding.rule === 'new-dependency')
        .map(
          (finding) =>
            `${finding.verdict}|${finding.subject.replace(/#sha256=[0-9a-f]{64}$/, '#sha256')}|${finding.path}`,
        );

    it('тот же yarnPath с тем же содержимым — не новый; подменённое содержимое — новая зависимость', () => {
      const same = toolchain({});
      expect(newDeps(same.dir, same.base)).toEqual([]);
      const changed = toolchain({ '.yarn/releases/yarn.cjs': 'подменённый yarn' });
      expect(newDeps(changed.dir, changed.base)).toEqual([
        'violation|yarnPath@.yarn/releases/yarn.cjs#sha256|.yarnrc.yml',
      ]);
    });

    it('новый плагин — нарушение, пока не внесён в допуск с причиной (предмет — путь и хэш)', () => {
      const { dir, base } = toolchain({
        '.yarnrc.yml': yarnrc(
          'enableScripts: false\nyarnPath: .yarn/releases/yarn.cjs\nplugins:\n  - .yarn/plugins/p.cjs\n',
        ),
        '.yarn/plugins/p.cjs': 'плагин',
      });
      expect(newDeps(dir, base)).toEqual(['violation|plugin@.yarn/plugins/p.cjs#sha256|.yarnrc.yml']);
      const subject = `plugin@.yarn/plugins/p.cjs#sha256=${createHash('sha256').update('плагин').digest('hex')}`;
      expect(newDeps(dir, base, { [subject]: REASON })).toEqual([]);
    });

    it('зависимость, которую добавляет packageExtensions, — новая зависимость; уже прямая в базе — нет', () => {
      const { dir, base } = toolchain({
        '.yarnrc.yml': yarnrc(
          'enableScripts: false\nyarnPath: .yarn/releases/yarn.cjs\npackageExtensions:\n  "hook-a@*":\n    dependencies:\n      bb-lib: "1.0.0"\n      hook-b: "1.0.0"\n',
        ),
      });
      expect(newDeps(dir, base)).toEqual(['violation|bb-lib|.yarnrc.yml']);
    });

    it('файл yarnPath вне репозитория — правило «не прочитано»', () => {
      const { dir, base } = toolchain({ '.yarnrc.yml': yarnrc('yarnPath: ../yarn.cjs\n') });
      expect(newDeps(dir, base)).toEqual(['broken|вход правила|.yarnrc.yml']);
    });

    it('файл базовой линии пишет предметы yarnPath и плагинов: перезаписанная база их не требует', () => {
      const { dir } = toolchain({});
      TempDir.write(dir, { 'base.json': DepsGuard.renderBaseline(dir) });
      expect(JSON.parse(readFileSync(join(dir, 'base.json'), 'utf8')).dependencies).toEqual([
        'hook-a',
        'hook-b',
        expect.stringMatching(/^yarnPath@\.yarn\/releases\/yarn\.cjs#sha256=[0-9a-f]{64}$/),
      ]);
      expect(check(dir).findings.filter((finding) => finding.rule === 'new-dependency')).toEqual([]);
    });
  });

  it('переменные YARN_* в окружении гейта — предупреждение с именами (без значений), код не меняется', () => {
    const dir = project('scripts', { '.yarnrc.yml': yarnrc('enableScripts: false\n') });
    const report = RunCheck.run({
      root: dir,
      config: config(),
      metadata: { 'hook-a': HOOKED, 'hook-b': HOOKED },
      now: NOW,
      env: { YARN_ENABLE_SCRIPTS: '1', yarn_npm_auth_token: 'npm_SECRET_VALUE', PATH: '/bin' },
    });
    expect(report.warnings).toEqual([expect.stringContaining('YARN_ENABLE_SCRIPTS, yarn_npm_auth_token')]);
    expect(ExitCodeOf.report(report)).toBe(0);
    const text = RenderReport.render('text', report);
    expect(text).toContain('ПРЕДУПРЕЖДЕНИЕ: в окружении гейта заданы YARN_ENABLE_SCRIPTS');
    for (const format of ['text', 'json', 'sarif', 'junit'] as const) {
      expect(RenderReport.render(format, report)).not.toContain('npm_SECRET_VALUE');
    }
    expect(
      JSON.parse(RenderReport.render('sarif', report)).runs[0].invocations[0].toolExecutionNotifications,
    ).toHaveLength(1);
    expect(
      RunCheck.run({
        root: dir,
        config: config(),
        metadata: { 'hook-a': HOOKED, 'hook-b': HOOKED },
        now: NOW,
        env: { PATH: '/bin' },
      }).warnings,
    ).toBeUndefined();
  });
});
