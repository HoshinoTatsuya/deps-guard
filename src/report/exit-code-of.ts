import { EXIT_CODE } from '../constants/exit-code.constant';
import type { CheckReport } from '../types/check-report.type';

/**
 * Код выхода по отчёту: нарушения или устаревшие допуски — 1; иначе что-то
 * не проверено или не прочитано — 2; иначе 0 (созревший допуск свежести —
 * предупреждение, кода не меняет). «Не проверено» — не успех.
 */
export class ExitCodeOf {
  public static report(report: CheckReport): number {
    if (report.findings.some((finding) => finding.verdict === 'violation' || finding.verdict === 'stale')) {
      return EXIT_CODE.findings;
    }
    return report.findings.some((finding) => finding.verdict !== 'matured') ||
      report.rules.some((rule) => rule.status === 'broken')
      ? EXIT_CODE.unverified
      : EXIT_CODE.clean;
  }
}
