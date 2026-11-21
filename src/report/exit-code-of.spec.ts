import { EXIT_CODE } from '../constants/exit-code.constant';
import type { CheckReport } from '../types/check-report.type';
import type { Finding } from '../types/finding.type';
import type { RuleStatus } from '../types/rule-status.type';
import { ExitCodeOf } from './exit-code-of';

const finding = (verdict: Finding['verdict']): Finding => ({
  rule: 'source',
  verdict,
  path: 'x',
  subject: 's',
  reason: 'r',
});

const report = (verdicts: Array<Finding['verdict']>, statuses: RuleStatus[] = ['passed']): CheckReport => ({
  tool: { name: 'deps-guard', version: '0' },
  root: '/',
  rules: statuses.map((status) => ({ rule: 'source', title: 't', status, checked: 1 })),
  findings: verdicts.map(finding),
});

describe('ExitCodeOf', () => {
  it.each([
    [[], ['passed'], EXIT_CODE.clean],
    [['violation'], ['failed'], EXIT_CODE.findings],
    [['stale'], ['failed'], EXIT_CODE.findings],
    [['unverified', 'violation'], ['failed'], EXIT_CODE.findings],
    [['broken', 'stale'], ['failed'], EXIT_CODE.findings],
    [['unverified'], ['unverified'], EXIT_CODE.unverified],
    [['broken'], ['broken'], EXIT_CODE.unverified],
    [[], ['broken'], EXIT_CODE.unverified],
    [[], ['disabled'], EXIT_CODE.clean],
    [['matured'], ['passed'], EXIT_CODE.clean],
    [['matured', 'unverified'], ['unverified'], EXIT_CODE.unverified],
    [['matured', 'violation'], ['failed'], EXIT_CODE.findings],
  ] as Array<[Array<Finding['verdict']>, RuleStatus[], number]>)(
    'находки %j, правила %j → %d',
    (verdicts, statuses, code) => {
      expect(ExitCodeOf.report(report(verdicts, statuses))).toBe(code);
    },
  );

  it('коды различны: чисто, нарушения, не проверено', () => {
    expect(new Set(Object.values(EXIT_CODE)).size).toBe(3);
    expect(EXIT_CODE).toEqual({ clean: 0, findings: 1, unverified: 2 });
  });
});
