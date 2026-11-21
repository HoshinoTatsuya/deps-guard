import type { RuleId } from './rule-id.type';
import type { Verdict } from './verdict.type';

/** Находка правила: вердикт, путь (относительно корня проекта), предмет и причина. */
export interface Finding {
  readonly rule: RuleId;
  readonly verdict: Verdict;
  /** Файл, к которому относится находка, относительно корня проекта. */
  readonly path: string;
  /** Строка в файле (с 1), если известна. */
  readonly line?: number;
  /** Предмет: пакет `имя@версия`, имя зависимости, ключ настройки. */
  readonly subject: string;
  readonly reason: string;
}
