/**
 * Текст вне поддерживаемого подмножества YAML или с нарушенной структурой.
 * Разборщик не угадывает: «не понял» — отказ с номером строки, а не пропуск.
 */
export class YamlSubsetError extends Error {
  public constructor(
    public readonly line: number,
    /** Причина без номера строки: вызывающий ставит свой путь и строку. */
    public readonly detail: string,
  ) {
    super(`строка ${line}: ${detail}`);
    this.name = 'YamlSubsetError';
  }
}
