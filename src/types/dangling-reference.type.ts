/** Прямая зависимость, указывающая на пакет, которого нет в lock-файле. */
export interface DanglingReference {
  /** Проект (`.` — корень). */
  readonly importer: string;
  readonly name: string;
  /** Версия или ссылка, как записана у прямой зависимости. */
  readonly version: string;
  readonly line?: number;
}
