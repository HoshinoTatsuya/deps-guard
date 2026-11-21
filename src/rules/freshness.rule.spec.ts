import { RuleContextOf } from '../testing/rule-context-of';
import type { PackageMetadata } from '../types/package-metadata.type';
import { FreshnessRule } from './freshness.rule';

const REASON = 'исправление уязвимости, ждать неделю дороже риска';
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number): string => new Date(RuleContextOf.NOW.getTime() - days * DAY).toISOString();

const metadata = (entries: Record<string, string>): Map<string, PackageMetadata> =>
  new Map(Object.entries(entries).map(([name, stamp]) => [name, { time: { '1.0.0': stamp } }]));

describe('FreshnessRule', () => {
  it('старые — без находок; моложе порога — нарушение; допуск снимает; дата в будущем — нарушение; без даты — не проверено', () => {
    const outcome = FreshnessRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock(
          ['old', 'fresh', 'allowed', 'future', 'nodate', 'baddate']
            .map((name) => RuleContextOf.pkg(name, '1.0.0'))
            .concat([
              RuleContextOf.pkg('gitdep', '1.0.0', {
                kind: 'git',
                url: 'https://g/x',
                commit: 'a'.repeat(40),
              }),
            ]),
        ),
        metadata: metadata({
          old: ago(30),
          fresh: ago(2),
          allowed: ago(1),
          future: ago(-3),
          baddate: 'вчера',
        }),
        config: { freshness: { allow: { 'allowed@1.0.0': REASON } } },
      }),
    );
    expect(outcome.findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['violation', 'fresh@1.0.0'],
      ['violation', 'future@1.0.0'],
      ['unverified', '2 версий'],
    ]);
    expect(outcome.findings[1]?.reason).toContain('в будущем');
    expect(outcome.findings[2]?.reason).toContain('baddate@1.0.0 (дата «вчера» не разобрана)');
    expect(outcome.checked).toBe(6);
  });

  it('граница порога: ровно minAgeDays — можно, на минуту моложе — нельзя', () => {
    const run = (stamp: string): number =>
      FreshnessRule.run(
        RuleContextOf.make({
          lock: RuleContextOf.lock([RuleContextOf.pkg('edge', '1.0.0')]),
          metadata: metadata({ edge: stamp }),
          config: { freshness: { minAgeDays: 3 } },
        }),
      ).findings.length;
    expect(run(ago(3))).toBe(0);
    expect(run(new Date(RuleContextOf.NOW.getTime() - 3 * DAY + 60_000).toISOString())).toBe(1);
  });

  it('дата в будущем — нарушение даже при допуске версии: кэшу нельзя доверять', () => {
    const outcome = FreshnessRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock([RuleContextOf.pkg('future', '1.0.0')]),
        metadata: metadata({ future: ago(-3) }),
        config: { freshness: { allow: { 'future@1.0.0': REASON } } },
      }),
    );
    expect(outcome.findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['violation', 'future@1.0.0'],
      ['stale', 'freshness.allow["future@1.0.0"]'],
    ]);
  });

  it('по умолчанию порог 7 дней', () => {
    const run = (days: number): number =>
      FreshnessRule.run(
        RuleContextOf.make({
          lock: RuleContextOf.lock([RuleContextOf.pkg('p', '1.0.0')]),
          metadata: metadata({ p: ago(days) }),
        }),
      ).findings.length;
    expect([run(6.9), run(7)]).toEqual([1, 0]);
  });

  it('допуск созревшей версии — «созрело» (предупреждение), отсутствующей — устарело', () => {
    const outcome = FreshnessRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock([RuleContextOf.pkg('p', '1.0.0')]),
        metadata: metadata({ p: ago(40) }),
        config: { freshness: { allow: { 'p@1.0.0': REASON, 'q@2.0.0': REASON } } },
      }),
    );
    expect(outcome.findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['stale', 'freshness.allow["q@2.0.0"]'],
      ['matured', 'freshness.allow["p@1.0.0"]'],
    ]);
  });

  it('допуск версии без даты — «не проверено» одной находкой, а не «устарело»; созревшей — «созрело»', () => {
    const outcome = FreshnessRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock([RuleContextOf.pkg('nodate', '1.0.0'), RuleContextOf.pkg('old', '1.0.0')]),
        metadata: metadata({ old: ago(30) }),
        config: { freshness: { allow: { 'nodate@1.0.0': REASON, 'old@1.0.0': REASON } } },
      }),
    );
    expect(outcome.findings.map((finding) => [finding.verdict, finding.subject])).toEqual([
      ['unverified', '1 версий'],
      ['matured', 'freshness.allow["old@1.0.0"]'],
    ]);
  });

  it('версия с именем свойства Object.prototype — нет даты, а не функция вместо даты', () => {
    const outcome = FreshnessRule.run(
      RuleContextOf.make({
        lock: RuleContextOf.lock([RuleContextOf.pkg('odd', 'constructor')]),
        metadata: new Map([['odd', { time: {} }]]),
      }),
    );
    expect(outcome.findings.map((finding) => finding.reason)).toEqual([
      expect.stringMatching(/odd@constructor$/),
    ]);
  });
});
