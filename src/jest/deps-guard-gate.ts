import { describe, expect, it } from '@jest/globals';

import { RunCheck } from '../check/run-check';
import { RenderReport } from '../report/render-report';
import type { CheckOptions } from '../types/check-options.type';

/**
 * Гейт поставок в наборе jest: `describe` с одним `it` на правило. Находки
 * правила — в сообщении упавшего теста; «не проверено» и «не прочитано» —
 * тоже красный тест. Отключённое настройкой правило — `it.skip` с причиной в
 * имени: в отчёте видно, что не проверялось и почему.
 */
export function depsGuardGate(options: CheckOptions & { readonly title?: string }): void {
  describe(options.title ?? 'deps-guard: цепочка поставок зависимостей', () => {
    const report = RunCheck.run(options);
    for (const summary of report.rules) {
      if (summary.status === 'disabled') {
        it.skip(`${summary.rule} [отключено: ${summary.disabledReason ?? ''}]`, () => undefined);
        continue;
      }
      it(`${summary.rule}: ${summary.title}`, () => {
        const own = report.findings.filter((finding) => finding.rule === summary.rule);
        expect(own.map((finding) => RenderReport.line(finding))).toEqual([]);
        expect(summary.status).toBe('passed');
      });
    }
  });
}
