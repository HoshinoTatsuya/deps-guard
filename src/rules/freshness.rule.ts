import type { Finding } from '../types/finding.type';
import type { RuleContext } from '../types/rule-context.type';
import type { RuleOutcome } from '../types/rule-outcome.type';
import { valueText } from '../value-text';
import { AllowEntries } from './allow-entries';

/**
 * Правило 5. Версия из реестра опубликована не позже чем `freshness.minAgeDays`
 * (по умолчанию 7) дней назад: вредоносную версию обычно снимают с реестра за
 * часы-дни, и порог не даёт ей доехать до CI. Дата — из метаданных (кэш в
 * репозитории или переданные вызывающим). Нет даты — «не проверено», не
 * зелёный. Дата в будущем — нарушение: кэшу нельзя доверять.
 *
 * Допуск — `имя@версия` с причиной; когда версия «созрела», допуск больше не
 * нужен — вердикт `matured`, предупреждение без смены кода выхода (версия
 * созревает сама, без коммита; красный цвет на законном состоянии отключили бы).
 * Допуск версии, которой нет в lock-файле, — «устарело». У версии без даты
 * допуск не устаревает: созрела ли она, неизвестно.
 * git-, file- и прочие не-реестровые пакеты даты публикации не имеют — их
 * судит правило источников.
 */
export class FreshnessRule {
  public static readonly id = 'freshness' as const;

  public static readonly DEFAULT_MIN_AGE_DAYS = 7;

  private static readonly DAY_MS = 24 * 60 * 60 * 1000;

  public static run(context: RuleContext): RuleOutcome {
    const section = context.config.freshness;
    const minAge = section?.minAgeDays ?? FreshnessRule.DEFAULT_MIN_AGE_DAYS;
    const now = context.now.getTime();
    const findings: Finding[] = [];
    const unknown: string[] = [];
    const fresh = new Set<string>();
    const matured = new Set<string>();
    // Допуск версии без даты не «устарел»: проверить его нечем, это «не проверено», а не «удалите».
    const undated = new Set<string>();
    const seen = new Set<string>();
    for (const pkg of context.lock.packages) {
      const id = `${pkg.name}@${pkg.version}`;
      if (seen.has(id) || (pkg.source.kind !== 'registry-default' && pkg.source.kind !== 'tarball')) {
        continue;
      }
      seen.add(id);
      const time = context.metadata.get(pkg.name)?.time;
      const stamp = time !== undefined && Object.hasOwn(time, pkg.version) ? time[pkg.version] : undefined;
      const published = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
      if (typeof stamp !== 'string' || Number.isNaN(published)) {
        undated.add(id);
        unknown.push(stamp === undefined ? id : `${id} (дата «${valueText(stamp)}» не разобрана)`);
        continue;
      }
      const place = {
        path: context.lock.path,
        ...(pkg.line === undefined ? {} : { line: pkg.line }),
        subject: id,
      };
      if (published > now + FreshnessRule.DAY_MS) {
        findings.push({
          rule: 'freshness',
          verdict: 'violation',
          ...place,
          reason: `дата публикации ${stamp} в будущем: метаданным нельзя доверять`,
        });
        continue;
      }
      const ageDays = (now - published) / FreshnessRule.DAY_MS;
      if (ageDays >= minAge) {
        matured.add(id);
        continue;
      }
      fresh.add(id);
      if (!AllowEntries.isAllowed(section?.allow, id)) {
        findings.push({
          rule: 'freshness',
          verdict: 'violation',
          ...place,
          reason: `опубликована ${Math.max(0, ageDays).toFixed(1)} дн. назад — моложе порога ${minAge} дн.`,
        });
      }
    }
    if (unknown.length > 0) {
      findings.push({
        rule: 'freshness',
        verdict: 'unverified',
        path: section?.metadataFile ?? context.configPath,
        subject: `${unknown.length} версий`,
        reason: `нет даты публикации в метаданных (freshness.metadataFile, deps-guard metadata): ${unknown.slice(0, 10).join(', ')}${unknown.length > 10 ? ` и ещё ${unknown.length - 10}` : ''}`,
      });
    }
    findings.push(
      ...AllowEntries.audit(
        'freshness',
        'freshness',
        section?.allow,
        context.configPath,
        (id) => fresh.has(id) || undated.has(id) || matured.has(id),
      ),
    );
    for (const id of Object.keys(section?.allow ?? {})) {
      if (matured.has(id) && !fresh.has(id) && AllowEntries.isAllowed(section?.allow, id)) {
        findings.push({
          rule: 'freshness',
          verdict: 'matured',
          path: context.configPath,
          subject: `freshness.allow["${id}"]`,
          reason: `версия старше порога ${minAge} дн.: допуск больше не нужен — удалите запись`,
        });
      }
    }
    return { findings, checked: seen.size };
  }
}
