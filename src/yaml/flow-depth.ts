import { YamlSubsetError } from './yaml-subset.error';

/**
 * Глубина незакрытых `{`/`[` многострочной flow-коллекции, считаемая по мере
 * чтения строк: каждая строка просматривается один раз. Пересчёт по всему
 * накопленному тексту на каждой строке делал разбор квадратичным — коллекция
 * на 16 тыс. строк читалась секунды, а её может прислать любой PR.
 *
 * Строка в кавычках, не закрытая до конца строки файла, — отказ: перевод
 * строки внутри кавычек разборщики сворачивают по-разному.
 */
export class FlowDepth {
  private depth = 0;

  private quote: string | undefined;

  private closed = false;

  /** Добавить кусок текста; результат — глубина после него (0 — коллекция закрыта). */
  public feed(piece: string, no: number): number {
    for (let index = 0; index < piece.length && !this.closed; index += 1) {
      const char = piece[index] as string;
      if (this.quote === '"' && char === '\\') {
        index += 1;
      } else if (this.quote !== undefined) {
        this.quote = char === this.quote ? undefined : this.quote;
      } else if (char === "'" || char === '"') {
        this.quote = char;
      } else if (char === '{' || char === '[') {
        this.depth += 1;
      } else if (char === '}' || char === ']') {
        this.depth -= 1;
        this.closed = this.depth === 0;
      }
    }
    if (this.quote !== undefined) {
      throw new YamlSubsetError(no, 'строка в кавычках перенесена на другую строку');
    }
    return this.closed ? 0 : this.depth;
  }
}
