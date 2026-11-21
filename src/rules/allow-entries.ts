import { MIN_REASON_LENGTH } from '../constants/min-reason-length.constant';
import type { AllowList } from '../types/allow-list.type';
import type { Finding } from '../types/finding.type';
import type { RuleId } from '../types/rule-id.type';
import { ReasonLength } from './reason-length';

/**
 * Записи допуска правила. Запись с причиной короче {@link MIN_REASON_LENGTH}
 * видимых знаков ({@link ReasonLength}) — нарушение и допуском не считается;
 * запись, которой ничего не соответствует, — «устарело» (иначе список
 * допусков только растёт и через год разрешает то, о чём никто не помнит).
 * Предмет ищется только среди собственных ключей допуска: пакет `constructor`
 * не находит в списке унаследованную функцию.
 */
export class AllowEntries {
  public static isAllowed(allow: AllowList | undefined, subject: string): boolean {
    return allow !== undefined && Object.hasOwn(allow, subject) && ReasonLength.isEnough(allow[subject]);
  }

  public static audit(
    rule: RuleId,
    section: string,
    allow: AllowList | undefined,
    configPath: string,
    isLive: (subject: string) => boolean,
  ): Finding[] {
    return Object.entries(allow ?? {}).flatMap(([subject, reason]): Finding[] => {
      const where = `${section}.allow["${subject}"]`;
      if (!ReasonLength.isEnough(reason)) {
        return [
          {
            rule,
            verdict: 'violation',
            path: configPath,
            subject: where,
            reason: `причина короче ${MIN_REASON_LENGTH} знаков («${String(reason).trim()}»): допуск не принят`,
          },
        ];
      }
      if (!isLive(subject)) {
        return [
          {
            rule,
            verdict: 'stale',
            path: configPath,
            subject: where,
            reason: 'устарело: допуску ничего не соответствует — удалите запись',
          },
        ];
      }
      return [];
    });
  }
}
