import { EXIT_CODE } from '../constants/exit-code.constant';
import type { CheckReport } from '../types/check-report.type';
import type { Finding } from '../types/finding.type';
import { ExitCodeOf } from './exit-code-of';
import { RenderReport } from './render-report';

const FINDINGS: Finding[] = [
  {
    rule: 'source',
    verdict: 'violation',
    path: 'pnpm-lock.yaml',
    line: 12,
    subject: 'x@1.0.0',
    reason: 'архив <не> из "реестра" & co',
  },
  {
    rule: 'freshness',
    verdict: 'unverified',
    path: 'deps-guard.json',
    subject: '3 версий',
    reason: 'нет даты',
  },
  {
    rule: 'install-script',
    verdict: 'stale',
    path: 'deps-guard.json',
    subject: 'installScripts.allow["a"]',
    reason: 'устарело',
  },
];

const report = (findings: Finding[], broken = false): CheckReport => ({
  tool: { name: 'deps-guard', version: '0.0.0-spec' },
  root: '/r',
  lockfile: 'pnpm-lock.yaml',
  rules: [
    { rule: 'source', title: 'источники', status: findings.length ? 'failed' : 'passed', checked: 5 },
    {
      rule: 'freshness',
      title: 'свежесть',
      status: broken ? 'broken' : findings.length ? 'unverified' : 'passed',
      checked: 5,
    },
    { rule: 'install-script', title: 'скрипты', status: findings.length ? 'failed' : 'passed', checked: 5 },
    {
      rule: 'floating-range',
      title: 'диапазоны',
      status: 'disabled',
      checked: 0,
      disabledReason: 'библиотека, диапазоны нужны',
    },
  ],
  findings,
});

describe('ExitCodeOf', () => {
  it('нарушение или устарело — 1; только не проверено — 2; не прочитано без находок — 2; чисто — 0', () => {
    expect(ExitCodeOf.report(report(FINDINGS))).toBe(EXIT_CODE.findings);
    expect(ExitCodeOf.report(report([FINDINGS[2] as Finding]))).toBe(EXIT_CODE.findings);
    expect(ExitCodeOf.report(report([FINDINGS[1] as Finding]))).toBe(EXIT_CODE.unverified);
    expect(ExitCodeOf.report(report([], true))).toBe(EXIT_CODE.unverified);
    expect(ExitCodeOf.report(report([]))).toBe(EXIT_CODE.clean);
  });
});

describe('RenderReport', () => {
  it('SARIF 2.1.0: уровень и вид по вердикту, строка, правила каталога, отпечаток', () => {
    const sarif = JSON.parse(RenderReport.render('sarif', report(FINDINGS))) as {
      version: string;
      runs: Array<{
        tool: { driver: { rules: Array<{ id: string }> } };
        results: Array<{
          ruleId: string;
          level: string;
          kind: string;
          locations: Array<{
            physicalLocation: { artifactLocation: { uri: string }; region?: { startLine: number } };
          }>;
          partialFingerprints: Record<string, string>;
        }>;
      }>;
    };
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0];
    expect(run?.tool.driver.rules.map((rule) => rule.id)).toEqual([
      'new-dependency',
      'install-script',
      'source',
      'typosquatting',
      'freshness',
      'floating-range',
      'lock-mismatch',
      'banned-package',
      'input',
    ]);
    expect(run?.results.map((result) => [result.ruleId, result.level, result.kind])).toEqual([
      ['source', 'error', 'fail'],
      ['freshness', 'warning', 'review'],
      ['install-script', 'warning', 'fail'],
    ]);
    expect(run?.results[0]?.locations[0]?.physicalLocation).toEqual({
      artifactLocation: { uri: 'pnpm-lock.yaml', uriBaseId: '%SRCROOT%' },
      region: { startLine: 12 },
    });
    expect(run?.results[1]?.locations[0]?.physicalLocation.region).toBeUndefined();
    expect(run?.results[0]?.partialFingerprints['deps-guard/v1']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('JUnit: failure — нарушения, error — не проверено, skipped — отключено с причиной; XML экранирован', () => {
    const xml = RenderReport.render('junit', report(FINDINGS));
    expect(xml).toContain('<testsuites name="deps-guard" tests="4" failures="2" errors="1" skipped="1">');
    expect(xml).toContain(
      '<failure type="violation" message="находок: 1">pnpm-lock.yaml:12 [source/violation] x@1.0.0 — архив &lt;не&gt; из &quot;реестра&quot; &amp; co</failure>',
    );
    expect(xml).toContain('<error type="unverified"');
    expect(xml).toContain('<skipped message="отключено: библиотека, диапазоны нужны"/>');
    expect(xml.match(/<testcase /g)?.length).toBe(4);
  });

  it('текст: строка на правило, находки, итог с кодом', () => {
    const text = RenderReport.render('text', report(FINDINGS));
    expect(text).toContain('НАРУШЕНИЯ     source — источники (рассмотрено 5)');
    expect(text).toContain('отключено     floating-range — диапазоны: библиотека, диапазоны нужны');
    expect(text).toContain('  pnpm-lock.yaml:12 [source/violation] x@1.0.0 — архив <не> из "реестра" & co');
    expect(text).toContain(
      'Итог: нарушений 1, устарело 1, не проверено 1, не прочитано 0, созрело допусков 0 (удалите их, код не меняют) → код 1',
    );
    expect(JSON.parse(RenderReport.render('json', report(FINDINGS))).findings).toHaveLength(3);
  });
});
