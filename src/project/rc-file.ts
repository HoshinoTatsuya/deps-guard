import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';

/**
 * Ключи верхнего уровня `.npmrc` и `.yarnrc` проекта — так, как их читает
 * менеджер. Читаются ТОЛЬКО ключи, которые принял `wanted`: в тех же файлах
 * лежат токены реестров, остальные строки не разбираются и никуда не
 * выводятся. Повтор ключа — действует последний.
 *
 * `.npmrc` — формат ini (пакет `ini`, им читают npm, pnpm до 11 и yarn 1):
 * строки делит и CR, и LF; комментарий — строка с `;`/`#` в начале и хвост
 * значения после неэкранированного `;`/`#`; ключ и значение без пробелов по
 * краям, в кавычках — без кавычек; ключ без `=` — `true`.
 * `.yarnrc` — формат yarn 1: `ключ значение`, ключ и значение в кавычках или
 * без, ключ можно с `--`, хвост — комментарий `#`.
 *
 * Нужный ключ, который менеджеры читают по-разному или который не разобран, —
 * отказ {@link InputUnreadableError}, а не догадка: в `.npmrc` — после
 * заголовка секции `[…]` (npm и pnpm до 11 его на верхнем уровне не видят,
 * pnpm 12 берёт) и с суффиксом массива `[]`; в `.yarnrc` — строка с отступом
 * (вложенный ключ yarn настройкой не считает) и строка не по формату.
 */
export class RcFile {
  public static read(
    root: string,
    file: '.npmrc' | '.yarnrc',
    wanted: (key: string) => boolean,
  ): Map<string, { value: string; line: number }> {
    const path = join(root, file);
    return existsSync(path) ? RcFile.parse(readFileSync(path, 'utf8'), file, wanted) : new Map();
  }

  public static parse(
    text: string,
    file: '.npmrc' | '.yarnrc',
    wanted: (key: string) => boolean,
  ): Map<string, { value: string; line: number }> {
    const found = new Map<string, { value: string; line: number }>();
    let section: string | undefined;
    // BOM в начале файла менеджеры отбрасывают (yarn 1 — явно, ini npm — trim ключа):
    // в .yarnrc он иначе читался бы отступом, и первая строка — вложенным ключом.
    text
      .replace(/^\uFEFF/, '')
      .split(/\r\n|\r|\n/)
      .forEach((raw, index) => {
        const line = index + 1;
        if (file === '.npmrc' && /^\s*\[/.test(raw)) {
          section = raw.trim();
          return;
        }
        const entry = file === '.npmrc' ? RcFile.iniEntry(raw) : RcFile.yarnEntry(raw);
        if (entry === undefined || !wanted(entry.key.replace(/\[\]$/, ''))) {
          return;
        }
        const refuse = (detail: string): never => {
          throw new InputUnreadableError(file, `${entry.key}: ${detail}`, line);
        };
        if (section !== undefined) {
          refuse(
            `ключ в секции ${section}: npm и pnpm до 11 его не читают, pnpm 12 читает — вынесите над секциями`,
          );
        }
        if (entry.key.endsWith('[]')) {
          refuse('ключ-массив «[]»: значение настройки не одно — запишите одной строкой без «[]»');
        }
        if (entry.nested) {
          refuse(
            'строка с отступом — вложенный ключ, yarn его настройкой не считает; уберите отступ или строку',
          );
        }
        if (entry.value === undefined) {
          refuse('строка не разобрана (ожидалось «ключ значение»)');
        }
        found.set(entry.key, { value: entry.value as string, line });
      });
    return found;
  }

  /** Строка ini: `ключ = значение`; комментарий и пустая строка — `undefined`. */
  private static iniEntry(raw: string): { key: string; value: string; nested: boolean } | undefined {
    if (/^\s*(?:[;#]|$)/.test(raw)) {
      return undefined;
    }
    const at = raw.indexOf('=');
    const key = RcFile.iniValue(at < 0 ? raw : raw.slice(0, at));
    return { key, value: at < 0 ? 'true' : RcFile.iniValue(raw.slice(at + 1)), nested: false };
  }

  /** Значение ini: в кавычках — содержимое; иначе до неэкранированного `;`/`#`; `\;` `\#` `\\` — знаки. */
  private static iniValue(text: string): string {
    const value = text.trim();
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    if (quoted !== null) {
      if (value.startsWith("'")) {
        return quoted[1] as string;
      }
      try {
        return String(JSON.parse(value));
      } catch {
        return value;
      }
    }
    let result = '';
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index] as string;
      if (char === ';' || char === '#') {
        break;
      }
      if (char === '\\') {
        const next = value[index + 1];
        result += next !== undefined && ';#\\'.includes(next) ? next : `\\${next ?? ''}`;
        index += 1;
        continue;
      }
      result += char;
    }
    return result.trim();
  }

  /**
   * Строка `.yarnrc`: `[--]ключ значение [# комментарий]`. Не по формату —
   * `value: undefined` (вызывающий откажет, если ключ нужный).
   */
  private static yarnEntry(raw: string): { key: string; value?: string; nested: boolean } | undefined {
    if (/^\s*(?:#|$)/.test(raw)) {
      return undefined;
    }
    const token = String.raw`("(?:[^"\\]|\\.)*"|[^\s"#]+)`;
    const match = new RegExp(String.raw`^(\s*)(?:--)?${token}\s+${token}\s*(?:#.*)?$`).exec(raw);
    if (match === null) {
      const key = /^\s*(?:--)?"?([^\s"#:]+)/.exec(raw)?.[1];
      return key === undefined ? undefined : { key, nested: /^\s/.test(raw) };
    }
    const key = match[2] as string;
    const nested = (match[1] as string) !== '';
    // `ключ: значение` — форма вложенного блока yarn, а не настройка: читается ли она, не угадываем.
    return key.endsWith(':')
      ? { key: key.slice(0, -1), nested }
      : { key: RcFile.yarnToken(key), value: RcFile.yarnToken(match[3] as string), nested };
  }

  private static yarnToken(token: string): string {
    if (!token.startsWith('"')) {
      return token;
    }
    try {
      return String(JSON.parse(token));
    } catch {
      return token;
    }
  }
}
