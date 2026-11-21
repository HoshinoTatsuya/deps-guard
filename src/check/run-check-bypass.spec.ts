import { symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { ExitCodeOf } from '../report/exit-code-of';
import { RenderReport } from '../report/render-report';
import { TempDir } from '../testing/temp-dir';
import type { CheckReport } from '../types/check-report.type';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';
import type { PackageMetadata } from '../types/package-metadata.type';
import { RunCheck } from './run-check';

/**
 * Обходы гейта, найденные повторным аудитом: соседние формы уже закрытых
 * классов (секции ini, табуляция, регистр протокола, смена источника под
 * старым ключом, скрытый каталог workspace), а также законные двойники,
 * на которых гейт не должен краснеть.
 */
const NOW = new Date('2026-11-16T00:00:00Z');
const I = `sha512-${'A'.repeat(86)}==`;
const REASON = 'проверено вручную: источник и назначение пакета известны';
const NPMJS = 'https://registry.npmjs.org/';
const OLD: PackageMetadata = {
  time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
  versions: { '1.0.0': { hasInstallScript: false } },
};
const YARN_HEADER = '# yarn lockfile v1\n\n';
const POSTINSTALL = JSON.stringify({ name: 'dep', version: '1.0.0', scripts: { postinstall: 'node x.js' } });
const json = (value: unknown): string => JSON.stringify(value, null, 2);

const npmLock = (dependencies: Record<string, string>, packages: Record<string, unknown>): string =>
  json({
    name: 'root',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'root', dependencies }, ...packages },
  });

describe('RunCheck: обходы гейта и законные двойники', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      TempDir.remove(dir);
    }
  });

  const project = (files: Record<string, string>): string => {
    const dir = TempDir.create(files);
    dirs.push(dir);
    return dir;
  };

  const check = (
    dir: string,
    config?: DepsGuardConfig,
    metadata: Record<string, PackageMetadata> = {},
  ): CheckReport => RunCheck.run({ root: dir, ...(config ? { config } : {}), metadata, now: NOW });

  const of = (report: CheckReport, rule: string): string[] =>
    report.findings
      .filter((finding) => finding.rule === rule)
      .map((finding) => `${finding.verdict}|${finding.subject}|${finding.path}`);

  const localDep = (rc: Record<string, string>): string =>
    project({
      'package.json': json({ name: 'root', private: true, dependencies: { dep: 'file:dep' } }),
      'dep/package.json': POSTINSTALL,
      'package-lock.json': npmLock(
        { dep: 'file:dep' },
        { 'node_modules/dep': { resolved: 'dep', link: true }, dep: { name: 'dep', version: '1.0.0' } },
      ),
      ...rc,
    });

  const localConfig: DepsGuardConfig = {
    disabled: { 'new-dependency': REASON },
    sources: { registries: [NPMJS], defaultRegistry: NPMJS },
    floatingRanges: { fields: [] },
  };

  describe('.npmrc и .yarnrc читаются так, как их читает менеджер', () => {
    it('npm: ignore-scripts=true в секции [ci] npm не читает — не «чисто», а «не прочитано»', () => {
      const report = check(
        localDep({ '.npmrc': 'ignore-scripts=false\n[ci]\nignore-scripts=true\n' }),
        localConfig,
      );
      expect(of(report, 'install-script')).toEqual(['broken|настройка скриптов|.npmrc']);
      expect(report.findings.find((finding) => finding.rule === 'install-script')?.line).toBe(3);
      expect(ExitCodeOf.report(report)).toBe(2);
    });

    it('npm: ignore-scripts=true на верхнем уровне — скрипты запрещены (двойник)', () => {
      const report = check(localDep({ '.npmrc': 'ignore-scripts=true\n[ci]\nother=1\n' }), localConfig);
      expect(of(report, 'install-script')).toEqual([]);
    });

    it('yarn: вложенный «ci: ignore-scripts true» yarn настройкой не считает — «не прочитано»', () => {
      const dir = project({
        'package.json': json({ name: 'root', private: true, dependencies: { dep: 'file:./dep' } }),
        'dep/package.json': POSTINSTALL,
        '.yarnrc': 'ci:\n  ignore-scripts true\n',
        'yarn.lock': `${YARN_HEADER}"dep@file:./dep":\n  version "1.0.0"\n`,
      });
      const report = check(dir, {
        ...localConfig,
        sources: { ...localConfig.sources, allow: { 'dep@file:./dep': REASON } },
      });
      expect(of(report, 'install-script')).toEqual(['broken|настройка скриптов|.yarnrc']);
      expect(ExitCodeOf.report(report)).toBe(2);
    });

    it('реестр в секции .npmrc — правило источников «не прочитано» с путём и строкой', () => {
      const report = check(
        localDep({ '.npmrc': `registry=${NPMJS}\n[x]\nregistry=https://evil.example/\n` }),
        localConfig,
      );
      expect(
        report.findings
          .filter((finding) => finding.rule === 'source')
          .map((f) => [f.verdict, f.path, f.line]),
      ).toEqual([['broken', '.npmrc', 3]]);
    });

    it('значения токенов из .npmrc не попадают ни в находки, ни в один формат отчёта', () => {
      const secret = 'npm_TOKENVALUE_9f8e7d6c5b4a';
      const report = check(
        localDep({
          '.npmrc': [
            `//registry.npmjs.org/:_authToken=${secret}`,
            `//evil.example/:_password="${secret}"`,
            `_auth=${secret}`,
            `email=${secret}@example.com`,
            'registry=https://evil.example/',
            `"//q.example/:_authToken"=${secret}`,
            `x=1\r//cr.example/:_authToken=${secret}`,
            '',
          ].join('\n'),
        }),
        localConfig,
      );
      // Выборка не пустая: .npmrc прочитан, его реестр осуждён.
      expect(of(report, 'source')).toEqual(['violation|registry|.npmrc']);
      for (const format of ['text', 'json', 'sarif', 'junit'] as const) {
        expect(RenderReport.render(format, report)).not.toContain(secret);
      }
    });
  });

  describe('табуляция в pnpm-workspace.yaml и lock-файле', () => {
    const pnpmProject = (workspace: string, lockHead = ''): string =>
      project({
        'package.json': json({ name: 'root', private: true, packageManager: 'pnpm@12.4.1' }),
        'pnpm-workspace.yaml': workspace,
        'pnpm-lock.yaml': `${lockHead}lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n`,
      });

    it.each([
      ['configDependencies после «:\\t» не прячется', 'configDependencies:\t{bb-lib: 1.0.0+sha512-AAAA}\n'],
      ['явный ключ «? \\t"…"» не прочитан ключом с кавычками', '? \t"dangerouslyAllowAllBuilds"\n: true\n'],
    ])('pnpm-workspace.yaml: %s — вход не прочитан', (_name, workspace) => {
      const report = check(pnpmProject(workspace), localConfig);
      expect(report.findings.map((finding) => [finding.rule, finding.verdict, finding.path])).toEqual([
        ['input', 'broken', 'pnpm-workspace.yaml'],
      ]);
      expect(ExitCodeOf.report(report)).toBe(2);
    });

    it('lock-файл: config-зависимость после «:\\t» — вход не прочитан', () => {
      const report = check(
        pnpmProject(
          'packages: []\n',
          "---\nlockfileVersion: '9.0'\nimporters:\n  .:\n    configDependencies:\t{bb-lib: {specifier: 1.0.0, version: 1.0.0}}\n---\n",
        ),
        localConfig,
      );
      expect(report.findings.map((finding) => [finding.rule, finding.verdict, finding.path])).toEqual([
        ['input', 'broken', 'pnpm-lock.yaml'],
      ]);
    });
  });

  it('NPM: в верхнем регистре — алиас: новая зависимость цели, хотя ключ старый', () => {
    const dir = project({
      'package.json': json({ name: 'root', private: true, dependencies: { 'aa-lib': 'NPM:bb-lib@1.0.0' } }),
      'package-lock.json': npmLock(
        { 'aa-lib': 'NPM:bb-lib@1.0.0' },
        {
          'node_modules/aa-lib': {
            name: 'bb-lib',
            version: '1.0.0',
            resolved: `${NPMJS}bb-lib/-/bb-lib-1.0.0.tgz`,
            integrity: I,
          },
        },
      ),
      'base.json': json({ dependencies: ['aa-lib'] }),
    });
    const report = check(
      dir,
      {
        newDependencies: { baseline: { file: 'base.json' } },
        installScripts: { othersBlockedBy: REASON },
        sources: { registries: [NPMJS], defaultRegistry: NPMJS },
        floatingRanges: { fields: ['devDependencies'] },
      },
      { 'bb-lib': OLD },
    );
    expect(of(report, 'new-dependency')).toEqual(['violation|bb-lib|package.json']);
    expect(ExitCodeOf.report(report)).toBe(1);
  });

  describe('проекты workspace yarn', () => {
    const yarnProject = (extra: Record<string, string>): string =>
      project({
        'package.json': json({ name: 'root', private: true, workspaces: ['.tools/*'] }),
        '.tools/a/package.json': json({ name: 'a', version: '1.0.0', dependencies: { 'aa-lib': '^1.0.0' } }),
        'yarn.lock': `${YARN_HEADER}aa-lib@^1.0.0:\n  version "1.0.0"\n  resolved "${NPMJS}aa-lib/-/aa-lib-1.0.0.tgz#abc"\n  integrity ${I}\n`,
        'base.json': json({ dependencies: [] }),
        ...extra,
      });
    const config: DepsGuardConfig = {
      newDependencies: { baseline: { file: 'base.json' } },
      installScripts: { othersBlockedBy: REASON },
      sources: { registries: [NPMJS], defaultRegistry: NPMJS },
      floatingRanges: { fields: [] },
    };

    it('явный шаблон «.tools/*» заходит в скрытый каталог: зависимости проекта судятся', () => {
      const report = check(yarnProject({}), config, { 'aa-lib': OLD });
      expect(of(report, 'new-dependency')).toEqual(['violation|aa-lib|.tools/a/package.json']);
    });

    it('каталог-ссылка под шаблоном — вход не прочитан', () => {
      const dir = yarnProject({ 'outside/b/package.json': json({ name: 'b', version: '1.0.0' }) });
      symlinkSync(join(dir, 'outside', 'b'), join(dir, '.tools', 'b'));
      const report = check(dir, config, { 'aa-lib': OLD });
      expect(report.findings.map((finding) => [finding.rule, finding.verdict, finding.path])).toEqual([
        ['input', 'broken', '.tools/b'],
      ]);
    });
  });

  it('BOM в package.json и deps-guard.json — читается, как у npm; ssh:// и git@хост: — не «не разобран»', () => {
    const sha = 'a'.repeat(40);
    const dependencies = {
      viaSsh: `git+ssh://git@g.example/u/r.git#${sha}`,
      viaScp: `git@g.example:u/s.git#${sha}`,
    };
    const dir = project({
      'package.json': `﻿${json({ name: 'root', private: true, dependencies })}`,
      'deps-guard.json': `﻿${json({ ...localConfig, installScripts: { othersBlockedBy: REASON, allow: { viaSsh: REASON, viaScp: REASON } } })}`,
      'package-lock.json': npmLock(dependencies, {
        'node_modules/viaSsh': { version: '1.0.0', resolved: `git+ssh://git@g.example/u/r.git#${sha}` },
        'node_modules/viaScp': { version: '1.0.0', resolved: `git+ssh://git@g.example/u/s.git#${sha}` },
      }),
    });
    const report = check(dir, undefined);
    expect(report.findings.filter((finding) => finding.rule === 'input')).toEqual([]);
    expect(of(report, 'floating-range')).toEqual([]);
    expect(
      RunCheck.run({
        root: dir,
        now: NOW,
        config: { ...localConfig, floatingRanges: { fields: ['dependencies'] } },
      }).findings.filter((finding) => finding.rule === 'floating-range'),
    ).toEqual([]);
  });

  it('созревший допуск свежести — предупреждение «matured» и код 0, а не красный main без коммитов', () => {
    const dir = project({
      'package.json': json({ name: 'root', private: true, dependencies: { 'aa-lib': '1.0.0' } }),
      'package-lock.json': npmLock(
        { 'aa-lib': '1.0.0' },
        {
          'node_modules/aa-lib': {
            version: '1.0.0',
            resolved: `${NPMJS}aa-lib/-/aa-lib-1.0.0.tgz`,
            integrity: I,
          },
        },
      ),
    });
    const config: DepsGuardConfig = {
      disabled: { 'new-dependency': REASON },
      installScripts: { othersBlockedBy: REASON },
      sources: { registries: [NPMJS], defaultRegistry: NPMJS },
      freshness: { allow: { 'aa-lib@1.0.0': REASON, 'gone@1.0.0': REASON } },
    };
    const report = check(dir, config, { 'aa-lib': OLD });
    expect(of(report, 'freshness')).toEqual([
      'stale|freshness.allow["gone@1.0.0"]|<параметр config>',
      'matured|freshness.allow["aa-lib@1.0.0"]|<параметр config>',
    ]);
    expect(ExitCodeOf.report(report)).toBe(1);
    const matured = check(
      dir,
      { ...config, freshness: { allow: { 'aa-lib@1.0.0': REASON } } },
      { 'aa-lib': OLD },
    );
    expect(of(matured, 'freshness')).toEqual(['matured|freshness.allow["aa-lib@1.0.0"]|<параметр config>']);
    expect(matured.rules.find((rule) => rule.rule === 'freshness')?.status).toBe('passed');
    expect(ExitCodeOf.report(matured)).toBe(0);
    const text = RenderReport.render('text', matured);
    expect(text).toContain('созрело допусков 1');
    expect(text).toContain('[freshness/matured]');
    expect(text).toContain(`опорное время: ${NOW.toISOString()}`);
    expect(RenderReport.render('junit', matured)).toContain('<system-out>');
    expect(JSON.parse(RenderReport.render('sarif', matured)).runs[0].results[0]).toMatchObject({
      level: 'note',
      kind: 'informational',
    });
    const fresh = check(
      dir,
      { ...config, freshness: { allow: { 'aa-lib@1.0.0': REASON } } },
      { 'aa-lib': { ...OLD, time: { '1.0.0': '2026-11-15T00:00:00.000Z' } } },
    );
    expect(of(fresh, 'freshness')).toEqual([]);
  });

  it('YARN_* в окружении у проекта npm — без предупреждения (npm их не читает)', () => {
    const dir = localDep({ '.npmrc': 'ignore-scripts=true\n' });
    expect(
      RunCheck.run({ root: dir, config: localConfig, now: NOW, env: { YARN_REGISTRY: 'x' } }).warnings,
    ).toBeUndefined();
  });
});
