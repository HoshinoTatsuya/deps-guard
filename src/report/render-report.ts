import { createHash } from 'node:crypto';

import { RULE } from '../constants/rule.constant';
import type { CheckReport } from '../types/check-report.type';
import type { Finding } from '../types/finding.type';
import type { ReportFormat } from '../types/report-format.type';
import type { RuleId } from '../types/rule-id.type';
import type { RuleStatus } from '../types/rule-status.type';
import { ExitCodeOf } from './exit-code-of';

/**
 * Отчёт в форматах: текст для журнала CI, JSON, SARIF 2.1.0 (интерфейс
 * GitHub/GitLab/IDE) и JUnit XML (вкладка тестов CI). В SARIF «не проверено»
 * — `kind: review`, а не `pass`; в JUnit нарушение — `<failure>`, «не
 * проверено» и «не прочитано» — `<error>`, отключённое правило — `<skipped>`
 * с причиной: ни один формат не показывает непроверенное зелёным.
 */
export class RenderReport {
  private static readonly STATUS_TEXT: Readonly<Record<RuleStatus, string>> = {
    passed: 'чисто',
    failed: 'НАРУШЕНИЯ',
    unverified: 'НЕ ПРОВЕРЕНО',
    broken: 'НЕ ПРОЧИТАНО',
    disabled: 'отключено',
  };

  public static render(format: ReportFormat, report: CheckReport): string {
    switch (format) {
      case 'text':
        return RenderReport.text(report);
      case 'json':
        return `${JSON.stringify(report, null, 2)}\n`;
      case 'sarif':
        return `${JSON.stringify(RenderReport.sarif(report), null, 2)}\n`;
      case 'junit':
        return RenderReport.junit(report);
    }
  }

  /** Одна находка строкой: `путь:строка [правило/вердикт] предмет — причина`. */
  public static line(finding: Finding): string {
    const where = finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`;
    return `${where} [${finding.rule}/${finding.verdict}] ${finding.subject} — ${finding.reason}`;
  }

  private static text(report: CheckReport): string {
    const lines = [
      `${report.tool.name} ${report.tool.version}${report.lockfile ? ` — ${report.lockfile}` : ''}`,
      ...(report.now === undefined ? [] : [`опорное время: ${report.now}`]),
      ...(report.warnings ?? []).map((warning) => `ПРЕДУПРЕЖДЕНИЕ: ${warning}`),
    ];
    for (const rule of report.rules) {
      const tail =
        rule.status === 'disabled' ? `: ${rule.disabledReason ?? ''}` : ` (рассмотрено ${rule.checked})`;
      lines.push(`  ${RenderReport.STATUS_TEXT[rule.status].padEnd(13)} ${rule.rule} — ${rule.title}${tail}`);
    }
    if (report.findings.length > 0) {
      lines.push('', 'Находки:');
      lines.push(...report.findings.map((finding) => `  ${RenderReport.line(finding)}`));
    }
    const count = (verdict: Finding['verdict']): number =>
      report.findings.filter((finding) => finding.verdict === verdict).length;
    lines.push(
      '',
      `Итог: нарушений ${count('violation')}, устарело ${count('stale')}, не проверено ${count('unverified')}, не прочитано ${count('broken')}, созрело допусков ${count('matured')} (удалите их, код не меняют) → код ${ExitCodeOf.report(report)}`,
    );
    return `${lines.join('\n')}\n`;
  }

  private static sarif(report: CheckReport): object {
    const level = {
      violation: 'error',
      stale: 'warning',
      unverified: 'warning',
      broken: 'error',
      matured: 'note',
    } as const;
    const kind = {
      violation: 'fail',
      stale: 'fail',
      unverified: 'review',
      broken: 'review',
      matured: 'informational',
    } as const;
    return {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: {
            driver: {
              name: report.tool.name,
              version: report.tool.version,
              rules: (Object.keys(RULE) as RuleId[]).map((id) => ({
                id,
                shortDescription: { text: RULE[id].title },
              })),
            },
          },
          invocations: [
            {
              executionSuccessful: !report.findings.some((finding) => finding.verdict === 'broken'),
              ...(report.now === undefined ? {} : { properties: { now: report.now } }),
              ...(report.warnings === undefined
                ? {}
                : {
                    toolExecutionNotifications: report.warnings.map((warning) => ({
                      level: 'warning',
                      message: { text: warning },
                    })),
                  }),
            },
          ],
          results: report.findings.map((finding) => ({
            ruleId: finding.rule,
            level: level[finding.verdict],
            kind: kind[finding.verdict],
            message: { text: `${finding.subject}: ${finding.reason}` },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: encodeURI(finding.path), uriBaseId: '%SRCROOT%' },
                  ...(finding.line === undefined ? {} : { region: { startLine: finding.line } }),
                },
              },
            ],
            partialFingerprints: {
              'deps-guard/v1': createHash('sha256')
                .update([finding.rule, finding.verdict, finding.path, finding.subject].join('\u0000'))
                .digest('hex'),
            },
            properties: { verdict: finding.verdict, subject: finding.subject },
          })),
        },
      ],
    };
  }

  private static junit(report: CheckReport): string {
    const cases = report.rules.map((rule) => {
      const own = report.findings.filter((finding) => finding.rule === rule.rule);
      const name = RenderReport.xml(`${rule.rule}: ${rule.title}`);
      const body = RenderReport.xml(own.map((finding) => RenderReport.line(finding)).join('\n'));
      let inner = '';
      if (rule.status === 'disabled') {
        inner = `<skipped message="${RenderReport.xml(`отключено: ${rule.disabledReason ?? ''}`)}"/>`;
      } else if (rule.status === 'failed') {
        inner = `<failure type="violation" message="${RenderReport.xml(`находок: ${own.length}`)}">${body}</failure>`;
      } else if (rule.status === 'unverified' || rule.status === 'broken') {
        inner = `<error type="${rule.status}" message="${RenderReport.xml(RenderReport.STATUS_TEXT[rule.status])}">${body}</error>`;
      } else if (own.length > 0) {
        inner = `<system-out>${body}</system-out>`;
      }
      return `    <testcase classname="${report.tool.name}" name="${name}">${inner}</testcase>`;
    });
    const tally = (statuses: RuleStatus[]): number =>
      report.rules.filter((rule) => statuses.includes(rule.status)).length;
    const attrs = `tests="${report.rules.length}" failures="${tally(['failed'])}" errors="${tally(['unverified', 'broken'])}" skipped="${tally(['disabled'])}"`;
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites name="${report.tool.name}" ${attrs}>`,
      `  <testsuite name="${report.tool.name}" ${attrs}>`,
      ...cases,
      '  </testsuite>',
      '</testsuites>',
      '',
    ].join('\n');
  }

  private static xml(text: string): string {
    return text
      .replace(/[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
