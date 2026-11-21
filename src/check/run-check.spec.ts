import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ExitCodeOf } from '../report/exit-code-of';
import { GreenProject } from '../testing/green-project';
import { TempDir } from '../testing/temp-dir';
import type { CheckOptions } from '../types/check-options.type';
import { RunCheck } from './run-check';

describe('RunCheck на настоящем lock-файле pnpm 12', () => {
  let dir: string;

  beforeEach(() => {
    dir = GreenProject.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  it('зелёный проект: каждое правило «чисто» и рассмотрело непустую выборку; код 0', () => {
    const report = RunCheck.run({ root: dir, now: GreenProject.NOW });
    expect(report.findings).toEqual([]);
    expect(report.rules.map((rule) => [rule.rule, rule.status])).toEqual([
      ['input', 'passed'],
      ['new-dependency', 'passed'],
      ['install-script', 'passed'],
      ['source', 'passed'],
      ['typosquatting', 'passed'],
      ['freshness', 'passed'],
      ['floating-range', 'passed'],
      ['lock-mismatch', 'passed'],
      ['banned-package', 'passed'],
    ]);
    expect(report.rules.filter((rule) => rule.checked === 0)).toEqual([]);
    expect(report.lockfile).toBe('pnpm-lock.yaml');
    expect(report.tool.version).toBe(
      (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string })
        .version,
    );
    expect(ExitCodeOf.report(report)).toBe(0);
  });

  it('нет настройки — вход не прочитан, КАЖДОЕ правило не прочитано, код 2', () => {
    TempDir.remove(dir);
    dir = TempDir.create();
    TempDir.copyFixture('pnpm-project/head', dir);
    const report = RunCheck.run({ root: dir });
    expect(report.findings.map((finding) => [finding.rule, finding.verdict, finding.path])).toEqual([
      ['input', 'broken', 'deps-guard.json'],
    ]);
    expect(new Set(report.rules.map((rule) => rule.status))).toEqual(new Set(['broken']));
    expect(report.rules).toHaveLength(9);
    expect(ExitCodeOf.report(report)).toBe(2);
  });

  it('два lock-файла — отказ: неизвестно, какой ставит CI', () => {
    TempDir.write(dir, { 'package-lock.json': '{}' });
    const report = RunCheck.run({ root: dir });
    expect(report.findings.map((finding) => finding.reason)).toEqual([
      expect.stringContaining('несколько lock-файлов'),
    ]);
  });

  it('битый lock-файл — отказ с номером строки', () => {
    TempDir.write(dir, { 'pnpm-lock.yaml': "lockfileVersion: '9.0'\npackages:\n  a@1: !!x {}\n" });
    const report = RunCheck.run({ root: dir });
    expect(report.findings.map((finding) => [finding.verdict, finding.path, finding.line])).toEqual([
      ['broken', 'pnpm-lock.yaml', 3],
    ]);
  });

  it('отключение с причиной — disabled; с короткой причиной — нарушение и правило работает', () => {
    const config = GreenProject.config();
    const disabled = RunCheck.run({
      root: dir,
      now: GreenProject.NOW,
      config: { ...config, disabled: { typosquatting: 'свой список популярных пакетов ещё не собран' } },
    });
    expect(disabled.rules.find((rule) => rule.rule === 'typosquatting')?.status).toBe('disabled');
    const short = RunCheck.run({
      root: dir,
      now: GreenProject.NOW,
      config: { ...config, disabled: { typosquatting: 'лень' } },
    });
    expect(short.findings.map((finding) => [finding.rule, finding.subject])).toEqual([
      ['typosquatting', 'disabled.typosquatting'],
    ]);
    expect(short.rules.find((rule) => rule.rule === 'typosquatting')?.checked).toBeGreaterThan(0);
  });

  it('битый кэш метаданных — свежесть не прочитана (а скрипты — не проверены)', () => {
    TempDir.write(dir, { 'deps-guard.metadata.json': '[1]' });
    const report = RunCheck.run({ root: dir, now: GreenProject.NOW });
    const statuses = Object.fromEntries(report.rules.map((rule) => [rule.rule, rule.status]));
    expect([statuses.freshness, statuses['install-script']]).toEqual(['broken', 'unverified']);
  });

  /** Контракт DepsGuard.check: на непрочитанном входе — отчёт с `broken`, а не исключение. */
  it('битый параметр metadata — свежесть не прочитана, а не исключение', () => {
    const report = RunCheck.run({
      root: dir,
      now: GreenProject.NOW,
      metadata: { semver: 5 } as unknown as NonNullable<CheckOptions['metadata']>,
    });
    const statuses = Object.fromEntries(report.rules.map((rule) => [rule.rule, rule.status]));
    expect(statuses.freshness).toBe('broken');
    expect(report.findings.find((finding) => finding.rule === 'freshness')).toMatchObject({
      verdict: 'broken',
      path: 'параметр metadata',
    });
  });

  it('метаданные от вызывающего перекрывают кэш', () => {
    const fresh = {
      semver: {
        time: { '7.8.6': '2026-11-14T00:00:00Z' },
        versions: { '7.8.6': { hasInstallScript: false } },
      },
    };
    const report = RunCheck.run({ root: dir, now: GreenProject.NOW, metadata: fresh });
    expect(report.findings.map((finding) => [finding.rule, finding.subject])).toEqual([
      ['freshness', 'semver@7.8.6'],
    ]);
  });
});

describe('RunCheck.status', () => {
  const of = (...verdicts: Array<'violation' | 'stale' | 'unverified' | 'broken' | 'matured'>): string =>
    RunCheck.status(
      verdicts.map((verdict) => ({ rule: 'source', verdict, path: 'x', subject: 's', reason: 'r' })),
    );

  it.each([
    [[], 'passed'],
    [['violation'], 'failed'],
    [['stale'], 'failed'],
    [['broken', 'violation'], 'failed'],
    [['unverified', 'stale'], 'failed'],
    [['broken'], 'broken'],
    [['unverified', 'broken'], 'broken'],
    [['unverified'], 'unverified'],
    [['matured'], 'passed'],
    [['matured', 'unverified'], 'unverified'],
  ] as Array<[Array<'violation' | 'stale' | 'unverified' | 'broken' | 'matured'>, string]>)(
    '%j → %s',
    (verdicts, status) => {
      expect(of(...verdicts)).toBe(status);
    },
  );
});
