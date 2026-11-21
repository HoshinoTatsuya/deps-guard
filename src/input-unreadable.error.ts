/**
 * Вход гейта не прочитан: нет файла, битый JSON/YAML, неизвестный ключ
 * настройки, неподдерживаемый формат lock-файла. Гейт отвечает «не проверено»,
 * а не «чисто»: непрочитанный lock-файл — непроверенное дерево.
 */
export class InputUnreadableError extends Error {
  public constructor(
    /** Файл относительно корня проекта. */
    public readonly path: string,
    detail: string,
    public readonly line?: number,
  ) {
    super(`${path}${line === undefined ? '' : `:${line}`}: ${detail}`);
    this.name = 'InputUnreadableError';
  }
}
