import type { YamlValue } from './yaml-value.type';

/** Документ YAML и номера строк ключей его отображений (для пути и строки в находке). */
export interface YamlDocument {
  readonly value: YamlValue;
  /** Строка (с 1), на которой объявлен ключ отображения; `undefined` — ключа нет. */
  lineOf(owner: object, key: string): number | undefined;
}
