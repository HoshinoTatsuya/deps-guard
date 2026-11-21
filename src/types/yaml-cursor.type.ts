import type { YamlRawLine } from './yaml-raw-line.type';
import type { YamlSourceLine } from './yaml-source-line.type';

/**
 * Позиция разбора документа и номера строк ключей его отображений. Строки
 * хранятся как есть: блочному скаляру нужны пустые строки, комментарии и
 * хвостовые пробелы, которые структурный разбор пропускает. `replaced` —
 * значимая строка, которой подменена строка `index` (компактная запись
 * `- ключ: …` и `: ключ: …` разбирается как отображение с отступом содержимого).
 */
export interface YamlCursor {
  readonly lines: readonly YamlRawLine[];
  index: number;
  replaced?: { readonly index: number; readonly line: YamlSourceLine };
  readonly keyLines: WeakMap<object, Map<string, number>>;
}
