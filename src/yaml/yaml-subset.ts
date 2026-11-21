import type { YamlCursor } from '../types/yaml-cursor.type';
import type { YamlDocument } from '../types/yaml-document.type';
import type { YamlRawLine } from '../types/yaml-raw-line.type';
import type { YamlSourceLine } from '../types/yaml-source-line.type';
import type { YamlValue } from '../types/yaml-value.type';
import { FlowDepth } from './flow-depth';
import { YamlSubsetError } from './yaml-subset.error';

/**
 * Разбор подмножества YAML, которым пишутся lock-файл и настройки pnpm:
 * блочные отображения и последовательности, flow-отображения и -списки в одну
 * строку, строки в кавычках, блочные скаляры `|`/`>` (с индикаторами
 * сохранения и отступа — так сериализатор pnpm пишет многострочный
 * `deprecated`), явный ключ `? …` / `: …` (так пишется ключ длиннее 1024
 * знаков), комментарии, несколько документов через `---`.
 *
 * Правило одно: прочитанное обязано совпадать с тем, что прочтут ОБА
 * разборщика менеджеров — js-yaml (pnpm до 11, YAML 1.2 core) и разборщик
 * pnpm 12 (saphyr: читает скаляр по типу поля), а всё, что хоть один из них
 * читает иначе или неоднозначно, — отказ {@link YamlSubsetError} с номером
 * строки: якоря, теги, ключ слияния `<<`, одиночный CR и прочие символы,
 * которые разборщики считают переводом строки по-разному, табуляция в отступе
 * и как разделитель (после `:`, `-`, `?`, внутри flow-коллекции — js-yaml
 * читает её как пробел, pnpm 12 отказывает или читает иначе), многострочные
 * скаляры без блочного индикатора, повтор ключа, комментарий внутри
 * flow-коллекции, скаляр без кавычек, который js-yaml читает числом не в той
 * записи (`1.10` → 1.1, `010` → 10, `-0` → 0) или датой (`2027-01-13`), скаляр,
 * начинающийся с `,` `]` `}`, и ключ `True`/`~`/`1.0`, который становится
 * строкой `true`/`null`/`1`. Гейт поставок не имеет права прочесть файл
 * «примерно»: непонятая строка, принятая за пустое значение, — пропущенная
 * зависимость.
 *
 * Скаляры без кавычек остаются строками (кроме true/false/null), но только
 * те, что YAML прочёл бы той же строкой: каноническое целое `1440` — строка
 * `1440`, у js-yaml — число с той же записью.
 */
export class YamlSubset {
  private static readonly RESERVED_START = new Set(['&', '*', '!', '|', '>', '%', '@', '`']);

  private static readonly BOM = 0xfeff;

  private static readonly CR = 0x0d;

  private static readonly LF = 0x0a;

  /**
   * Числа YAML 1.2 core и js-yaml (с `_`, `0b`/`0o`/`0x` — каждое со своими
   * цифрами: `0b08b5…` у js-yaml строка, это checksum yarn, `.inf`, `.nan`).
   */
  private static readonly NUMBER_LIKE =
    /^[-+]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|\.(?:inf|Inf|INF)|0b[01_]+|0o[0-7_]+|0x[0-9a-fA-F_]+)$|^\.(?:nan|NaN|NAN)$/;

  /** Число, которое YAML прочтёт с той же записью: `String(Number(x)) === x` (`-0` — нет: это 0). */
  private static readonly CANONICAL_INTEGER = /^(?:0|-?[1-9][0-9]{0,14})$/;

  /** Метка времени YAML 1.1, которую js-yaml читает датой (pnpm 12 — строкой). */
  private static readonly TIMESTAMP =
    /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::?[0-9]{2})?))?)?$/;

  /**
   * Схема чтения скаляров без кавычек. `core` — как js-yaml по умолчанию
   * (pnpm): true/false/null, отказ на числах в другой записи, датах и булевых
   * YAML 1.1. `failsafe` — как yarn 2+ (js-yaml со схемой FAILSAFE): каждый
   * непустой скаляр — строка как написан, пустое значение — null.
   */
  private static schema: 'core' | 'failsafe' = 'core';

  /** Все документы, скаляры — по схеме FAILSAFE (так читает yarn.lock и .yarnrc.yml yarn 2+). */
  public static parseFailsafe(source: string): YamlDocument {
    const previous = YamlSubset.schema;
    YamlSubset.schema = 'failsafe';
    try {
      return YamlSubset.parse(source);
    } finally {
      YamlSubset.schema = previous;
    }
  }

  public static parseAll(source: string): YamlDocument[] {
    const text = source.charCodeAt(0) === YamlSubset.BOM ? source.slice(1) : source;
    YamlSubset.rejectCharacters(text);
    const documents: YamlRawLine[][] = [[]];
    const raws = text.split(/\r\n|\n/);
    // Перевод строки в конце файла завершает последнюю строку, а не открывает новую пустую.
    if (raws.length > 1 && raws[raws.length - 1] === '') {
      raws.pop();
    }
    raws.forEach((raw, index) => {
      const no = index + 1;
      if (raw === '---') {
        documents.push([]);
        return;
      }
      // `---x` js-yaml читает маркером документа и ключом `x`, разборщик YAML 1.2 — ключом `---x`.
      if (/^(?:\.\.\.|%|---)/.test(raw)) {
        throw new YamlSubsetError(no, 'директивы и маркеры документа, кроме «---», не поддерживаются');
      }
      documents[documents.length - 1]?.push({ raw, no });
    });
    return documents
      .filter(
        (lines, index) =>
          lines.some((line) => YamlSubset.isSignificant(line.raw)) || (index === 0 && documents.length === 1),
      )
      .map((lines) => YamlSubset.parseDocument(lines));
  }

  /** Ровно один документ; несколько или ни одного — отказ. */
  public static parse(source: string): YamlDocument {
    const documents = YamlSubset.parseAll(source);
    if (documents.length !== 1) {
      throw new YamlSubsetError(1, `ожидался один документ, найдено ${documents.length}`);
    }
    return documents[0] as YamlDocument;
  }

  private static rejectCharacters(text: string): void {
    for (let at = 0; at < text.length; at += 1) {
      const code = text.charCodeAt(at);
      if (!YamlSubset.isForbidden(code, text.charCodeAt(at + 1))) {
        continue;
      }
      throw new YamlSubsetError(
        text.slice(0, at).split('\n').length,
        code === YamlSubset.CR
          ? 'одиночный CR: разборщики YAML читают его как перевод строки, а этот файл так не пишется'
          : `символ U+${code.toString(16).toUpperCase().padStart(4, '0')} вне подмножества: разборщики YAML читают его по-разному`,
      );
    }
  }

  /**
   * Символы, которые разборщики YAML читают по-разному или как перевод
   * строки: управляющие C0 (кроме табуляции, LF и CR перед LF), DEL, C1 (в
   * том числе NEL), разделители строк и абзацев Unicode, BOM не в начале.
   */
  private static isForbidden(code: number, next: number): boolean {
    if (code === YamlSubset.CR) {
      return next !== YamlSubset.LF;
    }
    return (
      (code < 0x20 && code !== 0x09 && code !== YamlSubset.LF) ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      code === YamlSubset.BOM
    );
  }

  private static isSignificant(raw: string): boolean {
    return !/^[ \t]*(?:#.*)?$/.test(raw);
  }

  private static parseDocument(lines: readonly YamlRawLine[]): YamlDocument {
    const cursor: YamlCursor = { lines, index: 0, keyLines: new WeakMap() };
    const first = YamlSubset.peek(cursor);
    let value: YamlValue = null;
    if (first) {
      if (first.indent !== 0) {
        throw new YamlSubsetError(first.no, 'документ начинается с отступа');
      }
      if (YamlSubset.isBlockNode(first.text, first.no)) {
        value = YamlSubset.parseBlock(cursor, 0);
      } else if (YamlSubset.isFlowStart(first.text)) {
        // Документ целиком flow-коллекцией (запись JSON): закрывающая скобка — с любого отступа.
        cursor.index += 1;
        value = YamlSubset.parseFlowLines(cursor, first.text, first.no, -1);
      } else {
        value = YamlSubset.parseInline(first.text, first.no);
        cursor.index += 1;
      }
      const rest = YamlSubset.peek(cursor);
      if (rest) {
        throw new YamlSubsetError(rest.no, 'лишнее содержимое после корневого значения');
      }
    }
    const keyLines = cursor.keyLines;
    return {
      value,
      lineOf: (owner, key) => keyLines.get(owner)?.get(key),
    };
  }

  /** Следующая значимая строка (пустые и комментарии пропускаются). */
  private static peek(cursor: YamlCursor): YamlSourceLine | undefined {
    for (; cursor.index < cursor.lines.length; cursor.index += 1) {
      if (cursor.replaced?.index === cursor.index) {
        return cursor.replaced.line;
      }
      const { raw, no } = cursor.lines[cursor.index] as YamlRawLine;
      const leading = (/^[ \t]*/.exec(raw) as RegExpExecArray)[0];
      const rest = raw.slice(leading.length);
      if (rest === '' || rest.startsWith('#')) {
        continue;
      }
      if (leading.includes('\t')) {
        throw new YamlSubsetError(no, 'табуляция в отступе');
      }
      return { indent: leading.length, text: rest.replace(/[ \t]+$/, ''), no };
    }
    return undefined;
  }

  private static isBlockNode(text: string, no: number): boolean {
    return (
      YamlSubset.isSequenceItem(text) ||
      YamlSubset.isExplicitKey(text) ||
      YamlSubset.splitKey(text, no) !== undefined
    );
  }

  private static isSequenceItem(text: string): boolean {
    return /^-(?:[ \t]|$)/.test(text);
  }

  private static isExplicitKey(text: string): boolean {
    return /^\?(?:[ \t]|$)/.test(text);
  }

  /**
   * Текст после индикатора (`:`, `-`, `?`) на позиции `at` без пробелов-разделителей.
   * Табуляция в разделителе — отказ: js-yaml читает её как пробел, pnpm 12
   * отказывает («tabs disallowed», «':' must be followed by a valid YAML
   * whitespace») — у разборщиков нет общего прочтения, и гейт не угадывает
   * (`? \t"ключ"` гейт иначе прочёл бы ключом с кавычками).
   */
  private static afterIndicator(text: string, at: number, no: number): string {
    const rest = text.slice(at);
    const run = (/^[ \t]*/.exec(rest) as RegExpExecArray)[0];
    if (run.includes('\t')) {
      throw new YamlSubsetError(
        no,
        `табуляция после «${text.slice(at - 1, at)}»: разборщики js-yaml и pnpm 12 читают её по-разному — замените пробелом`,
      );
    }
    return rest.slice(run.length);
  }

  private static parseBlock(cursor: YamlCursor, indent: number): YamlValue {
    const line = YamlSubset.peek(cursor) as YamlSourceLine;
    return YamlSubset.isSequenceItem(line.text)
      ? YamlSubset.parseSequence(cursor, indent)
      : YamlSubset.parseMapping(cursor, indent);
  }

  private static parseMapping(cursor: YamlCursor, indent: number): YamlValue {
    const result: { [key: string]: YamlValue } = Object.create(null);
    const keyLines = new Map<string, number>();
    cursor.keyLines.set(result, keyLines);
    for (let line = YamlSubset.peek(cursor); line && line.indent === indent; line = YamlSubset.peek(cursor)) {
      if (YamlSubset.isSequenceItem(line.text)) {
        throw new YamlSubsetError(line.no, 'элемент последовательности среди ключей отображения');
      }
      const explicit = YamlSubset.isExplicitKey(line.text);
      const entry = explicit ? YamlSubset.explicitKey(line) : YamlSubset.splitKey(line.text, line.no);
      if (!entry) {
        throw new YamlSubsetError(line.no, 'ожидался ключ отображения «ключ: значение»');
      }
      if (keyLines.has(entry.key)) {
        throw new YamlSubsetError(
          line.no,
          `ключ «${entry.key}» повторён (первый — строка ${keyLines.get(entry.key)})`,
        );
      }
      keyLines.set(entry.key, line.no);
      cursor.index += 1;
      result[entry.key] = explicit
        ? YamlSubset.parseExplicitValue(cursor, indent, line.no)
        : YamlSubset.parseEntryValue(cursor, indent, entry.rest, line.no);
    }
    return result;
  }

  /** `? ключ` — ключ одной строкой (скаляр); значение — на следующей строке `: …`. */
  private static explicitKey(line: YamlSourceLine): { key: string; rest: string } {
    const content = YamlSubset.afterIndicator(line.text, 1, line.no);
    if (content === '' || content.startsWith('{') || content.startsWith('[')) {
      throw new YamlSubsetError(line.no, 'явный ключ «?» — только скаляр в одну строку');
    }
    if (content.startsWith("'") || content.startsWith('"')) {
      const quoted = YamlSubset.readQuoted(content, 0, line.no);
      YamlSubset.expectEnd(content, quoted.end, line.no);
      return { key: YamlSubset.checkKey(quoted.value, true, line.no), rest: '' };
    }
    const value = YamlSubset.parseInline(content, line.no);
    if (typeof value !== 'string') {
      throw new YamlSubsetError(line.no, `явный ключ «${content}» — не строка`);
    }
    return { key: YamlSubset.checkKey(value, false, line.no), rest: '' };
  }

  private static parseExplicitValue(cursor: YamlCursor, indent: number, keyNo: number): YamlValue {
    const line = YamlSubset.peek(cursor);
    if (!line || line.indent !== indent || !/^:(?:[ \t]|$)/.test(line.text)) {
      throw new YamlSubsetError(
        keyNo,
        'после явного ключа «?» ожидалась строка «: значение» с тем же отступом',
      );
    }
    const rest = YamlSubset.afterIndicator(line.text, 1, line.no);
    if (
      rest !== '' &&
      !rest.startsWith('{') &&
      !rest.startsWith('[') &&
      (YamlSubset.isSequenceItem(rest) || YamlSubset.splitKey(rest, line.no) !== undefined)
    ) {
      const nested = indent + (line.text.length - rest.length);
      cursor.replaced = { index: cursor.index, line: { indent: nested, text: rest, no: line.no } };
      return YamlSubset.parseBlock(cursor, nested);
    }
    cursor.index += 1;
    return YamlSubset.parseEntryValue(cursor, indent, rest, line.no);
  }

  private static parseEntryValue(cursor: YamlCursor, indent: number, rest: string, no: number): YamlValue {
    if (rest !== '') {
      if (rest.startsWith('|') || rest.startsWith('>')) {
        return YamlSubset.parseBlockScalar(cursor, indent, rest, no);
      }
      const value = YamlSubset.isFlowStart(rest)
        ? YamlSubset.parseFlowLines(cursor, rest, no, indent)
        : YamlSubset.parseInline(rest, no);
      YamlSubset.expectNoDeeper(cursor, indent);
      return value;
    }
    const next = YamlSubset.peek(cursor);
    if (next && next.indent > indent && YamlSubset.isFlowStart(next.text)) {
      cursor.index += 1;
      const value = YamlSubset.parseFlowLines(cursor, next.text, next.no, indent);
      YamlSubset.expectNoDeeper(cursor, indent);
      return value;
    }
    if (next && next.indent > indent) {
      return YamlSubset.parseBlock(cursor, next.indent);
    }
    if (next && next.indent === indent && YamlSubset.isSequenceItem(next.text)) {
      return YamlSubset.parseSequence(cursor, indent);
    }
    return null;
  }

  /**
   * Блочный скаляр `|`/`>` с индикатором сохранения (`-`, `+`) и отступа
   * (`1`–`9`) — по правилам YAML 1.2 (8.1): отступ содержимого — у первой
   * непустой строки или родительский + индикатор; у `>` одиночный перевод
   * строки между строками текста — пробел, у строк с бо́льшим отступом и
   * пустых — сохраняется.
   */
  private static parseBlockScalar(cursor: YamlCursor, parent: number, header: string, no: number): string {
    const match = /^([|>])(?:([1-9])([-+])?|([-+])([1-9])?)?(?: +#.*)?$/.exec(header);
    if (!match) {
      throw new YamlSubsetError(no, `заголовок блочного скаляра «${header}» не разобран`);
    }
    const folded = match[1] === '>';
    const indicator = match[2] ?? match[5];
    const chomping = match[3] ?? match[4] ?? '';
    let content = indicator === undefined ? undefined : parent + Number(indicator);
    let result = '';
    let empty = 0;
    let leadingSpaces = 0;
    let didRead = false;
    let moreIndented = false;
    for (; cursor.index < cursor.lines.length; cursor.index += 1) {
      const { raw, no: lineNo } = cursor.lines[cursor.index] as YamlRawLine;
      const spaces = (/^ */.exec(raw) as RegExpExecArray)[0].length;
      const blank = spaces === raw.length;
      if (content === undefined) {
        if (blank) {
          leadingSpaces = Math.max(leadingSpaces, spaces);
          empty += 1;
          continue;
        }
        if (spaces <= parent) {
          break;
        }
        if (leadingSpaces > spaces) {
          throw new YamlSubsetError(
            lineNo,
            'пустая строка блочного скаляра с отступом больше, чем у содержимого',
          );
        }
        content = spaces;
      }
      if (blank && spaces <= content) {
        empty += 1;
        continue;
      }
      if (spaces < content) {
        break;
      }
      const text = raw.slice(content);
      if (!folded) {
        result += '\n'.repeat(didRead ? 1 + empty : empty);
      } else if (text.startsWith(' ') || text.startsWith('\t')) {
        moreIndented = true;
        result += '\n'.repeat(didRead ? 1 + empty : empty);
      } else if (moreIndented) {
        moreIndented = false;
        result += '\n'.repeat(empty + 1);
      } else if (empty === 0) {
        result += didRead ? ' ' : '';
      } else {
        result += '\n'.repeat(empty);
      }
      result += text;
      didRead = true;
      empty = 0;
    }
    if (chomping === '+') {
      result += '\n'.repeat(didRead ? 1 + empty : empty);
    } else if (chomping === '' && didRead) {
      result += '\n';
    }
    return result;
  }

  private static parseSequence(cursor: YamlCursor, indent: number): YamlValue {
    const result: YamlValue[] = [];
    for (let line = YamlSubset.peek(cursor); line && line.indent === indent; line = YamlSubset.peek(cursor)) {
      if (!YamlSubset.isSequenceItem(line.text)) {
        break;
      }
      const content = YamlSubset.afterIndicator(line.text, 1, line.no);
      if (content === '') {
        cursor.index += 1;
        const next = YamlSubset.peek(cursor);
        if (next && next.indent > indent && YamlSubset.isFlowStart(next.text)) {
          cursor.index += 1;
          result.push(YamlSubset.parseFlowLines(cursor, next.text, next.no, indent));
          YamlSubset.expectNoDeeper(cursor, indent);
          continue;
        }
        result.push(next && next.indent > indent ? YamlSubset.parseBlock(cursor, next.indent) : null);
        continue;
      }
      if (YamlSubset.isFlowStart(content)) {
        cursor.index += 1;
        result.push(YamlSubset.parseFlowLines(cursor, content, line.no, indent));
        YamlSubset.expectNoDeeper(cursor, indent);
        continue;
      }
      if (content.startsWith('|') || content.startsWith('>') || YamlSubset.isExplicitKey(content)) {
        throw new YamlSubsetError(
          line.no,
          'блочный скаляр или явный ключ в элементе последовательности не поддерживаются',
        );
      }
      if (!content.startsWith('{') && !content.startsWith('[') && YamlSubset.splitKey(content, line.no)) {
        const nested = indent + (line.text.length - content.length);
        cursor.replaced = { index: cursor.index, line: { indent: nested, text: content, no: line.no } };
        result.push(YamlSubset.parseMapping(cursor, nested));
        continue;
      }
      cursor.index += 1;
      result.push(YamlSubset.parseInline(content, line.no));
      const next = YamlSubset.peek(cursor);
      if (next && next.indent > indent) {
        throw new YamlSubsetError(next.no, 'многострочный скаляр или лишний отступ не поддерживаются');
      }
    }
    return result;
  }

  private static isFlowStart(text: string): boolean {
    return text.startsWith('{') || text.startsWith('[');
  }

  private static expectNoDeeper(cursor: YamlCursor, indent: number): void {
    const next = YamlSubset.peek(cursor);
    if (next && next.indent > indent) {
      throw new YamlSubsetError(next.no, 'многострочный скаляр или лишний отступ не поддерживаются');
    }
  }

  /**
   * Flow-коллекция, начатая строкой `start` и, если не закрыта на ней,
   * продолженная следующими строками (так её пишет prettier: `{` и `}` на
   * своих строках). Строки продолжения склеиваются через пробел — так YAML
   * сворачивает перевод строки внутри flow-контекста. Глубина считается по мере
   * чтения ({@link FlowDepth}): каждая строка просматривается один раз. Пустая
   * строка, комментарий, строка в кавычках через перевод строки и строка
   * содержимого с отступом не глубже родителя — отказ (pnpm 12 такую не
   * читает); на отступе родителя допустима только закрывающая скобка —
   * её читают оба разборщика.
   */
  private static parseFlowLines(cursor: YamlCursor, start: string, no: number, parent: number): YamlValue {
    let text = start;
    const depth = new FlowDepth();
    let open = depth.feed(start, no);
    while (open > 0) {
      const line = cursor.lines[cursor.index];
      if (line === undefined) {
        throw new YamlSubsetError(no, 'flow-коллекция не закрыта до конца документа');
      }
      const leading = (/^[ \t]*/.exec(line.raw) as RegExpExecArray)[0];
      const body = line.raw.slice(leading.length).replace(/[ \t]+$/, '');
      if (body === '' || body.startsWith('#')) {
        throw new YamlSubsetError(
          line.no,
          'пустая строка или комментарий внутри многострочной flow-коллекции',
        );
      }
      if (leading.includes('\t')) {
        throw new YamlSubsetError(line.no, 'строка flow-коллекции с табуляцией в отступе');
      }
      const closer = leading.length <= parent;
      if (closer && !/^[\]}]/.test(body)) {
        throw new YamlSubsetError(line.no, 'строка flow-коллекции без отступа от родителя');
      }
      text += ` ${body}`;
      cursor.index += 1;
      open = depth.feed(` ${body}`, line.no);
      if (closer && open > 0) {
        throw new YamlSubsetError(line.no, 'скобка на отступе родителя не закрывает flow-коллекцию');
      }
    }
    const parsed = YamlSubset.readFlow(text, 0, no);
    YamlSubset.expectEnd(text, parsed.end, no);
    return parsed.value;
  }

  /** `ключ: остаток` — или `undefined`, если строка не запись отображения. */
  /**
   * `ключ: остаток` — или `undefined`, если строка не запись отображения.
   * Ключ кончается на первом `:`, за которым пробел, табуляция или конец
   * строки (так читают оба разборщика); разделитель — {@link afterIndicator}.
   */
  private static splitKey(text: string, no: number): { key: string; rest: string } | undefined {
    if (text.startsWith("'") || text.startsWith('"')) {
      const quoted = YamlSubset.readQuoted(text, 0, no);
      const after = text.slice(quoted.end);
      if (/^:(?:[ \t]|$)/.test(after)) {
        return {
          key: YamlSubset.checkKey(quoted.value, true, no),
          rest: YamlSubset.restOf(YamlSubset.afterIndicator(text, quoted.end + 1, no)),
        };
      }
      return undefined;
    }
    const match = /^(.*?):(?=[ \t]|$)/.exec(text);
    if (!match || match[1] === undefined) {
      return undefined;
    }
    const key = YamlSubset.trimSpaces(match[1]);
    if (key === '' || /^[{[\]},#&*!|>%@`'"]/.test(key) || /^[-?:](?:[ \t]|$)/.test(key)) {
      return undefined;
    }
    if (/[ \t]#/.test(key)) {
      throw new YamlSubsetError(no, `ключ «${key}» вне поддерживаемого подмножества`);
    }
    return {
      key: YamlSubset.checkKey(key, false, no),
      rest: YamlSubset.restOf(YamlSubset.afterIndicator(text, match[0].length, no)),
    };
  }

  private static restOf(text: string): string {
    const rest = YamlSubset.trimSpaces(text);
    return rest.startsWith('#') ? '' : rest;
  }

  /**
   * Ключ, который менеджер прочтёт той же строкой. `<<` — ключ слияния
   * (js-yaml сливает в отображение чужие поля, разборщик YAML 1.2 — нет);
   * ключ без кавычек `True`, `~`, `1.0` js-yaml превращает в `true`, `null`, `1`.
   */
  private static checkKey(key: string, quoted: boolean, no: number): string {
    if (key === '<<') {
      throw new YamlSubsetError(no, 'ключ слияния «<<» не поддерживается: его читают по-разному');
    }
    if (!quoted) {
      const resolved = YamlSubset.resolvePlain(key, no, false);
      if (typeof resolved !== 'string' && String(resolved) !== key) {
        throw new YamlSubsetError(no, `ключ «${key}» без кавычек читается как ${String(resolved)}`);
      }
    }
    return key;
  }

  private static parseInline(text: string, no: number): YamlValue {
    const first = text[0] ?? '';
    if (first === '{' || first === '[') {
      const parsed = YamlSubset.readFlow(text, 0, no);
      YamlSubset.expectEnd(text, parsed.end, no);
      return parsed.value;
    }
    if (first === "'" || first === '"') {
      const quoted = YamlSubset.readQuoted(text, 0, no);
      YamlSubset.expectEnd(text, quoted.end, no);
      return quoted.value;
    }
    if (YamlSubset.RESERVED_START.has(first) || first === '#' || /^[,\]}]/.test(first)) {
      throw new YamlSubsetError(
        no,
        `значение, начинающееся с «${first}», не поддерживается (якорь, тег, блочный скаляр, скобка)`,
      );
    }
    if (/^[-?:](?:[ \t]|$)/.test(text)) {
      throw new YamlSubsetError(no, `значение начинается с индикатора «${first}»`);
    }
    const commentAt = text.search(/[ \t]#/);
    const plain = YamlSubset.trimSpaces(commentAt >= 0 ? text.slice(0, commentAt) : text);
    if (/:(?:[ \t]|$)/.test(plain)) {
      throw new YamlSubsetError(no, `скаляр без кавычек содержит «: » — неоднозначно: ${plain}`);
    }
    return YamlSubset.resolvePlain(plain, no);
  }

  private static expectEnd(text: string, end: number, no: number): void {
    const rest = text.slice(end);
    if (YamlSubset.trimSpaces(rest) !== '' && !/^[ \t]+#/.test(rest)) {
      throw new YamlSubsetError(no, `лишний текст после значения: ${YamlSubset.trimSpaces(rest)}`);
    }
  }

  /**
   * Скаляр без кавычек. Значение `True`/`FALSE` и булевы YAML 1.1 (`yes`, `no`,
   * `on`, `off`, `y`, `n` в любом регистре) — отказ: pnpm 12 читает их по типу
   * поля (в строковом — строкой `True`, в булевом — `yes` как true), js-yaml —
   * наоборот; общего прочтения нет. `true`/`false` — булевы у обоих, а поле,
   * где ждут строку, проверяет тип само.
   */
  private static resolvePlain(plain: string, no: number, asValue = true): YamlValue {
    if (YamlSubset.schema === 'failsafe') {
      return plain === '' ? null : plain;
    }
    if (
      asValue &&
      /^(?:True|TRUE|False|FALSE|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/.test(plain)
    ) {
      throw new YamlSubsetError(
        no,
        `«${plain}» без кавычек pnpm 12 и js-yaml читают по-разному (булево или строка) — пишите true/false или в кавычках`,
      );
    }
    if (/^(?:true|True|TRUE)$/.test(plain)) {
      return true;
    }
    if (/^(?:false|False|FALSE)$/.test(plain)) {
      return false;
    }
    if (/^(?:null|Null|NULL|~)?$/.test(plain)) {
      return null;
    }
    if (YamlSubset.NUMBER_LIKE.test(plain) && !YamlSubset.CANONICAL_INTEGER.test(plain)) {
      throw new YamlSubsetError(
        no,
        `«${plain}» без кавычек YAML читает числом с другой записью — возьмите в кавычки`,
      );
    }
    if (YamlSubset.TIMESTAMP.test(plain)) {
      throw new YamlSubsetError(
        no,
        `«${plain}» без кавычек js-yaml читает датой, pnpm 12 — строкой: возьмите в кавычки`,
      );
    }
    return plain;
  }

  /** Пробелы и табуляции по краям — только они разделители в YAML (не NBSP и прочие `\s`). */
  private static trimSpaces(text: string): string {
    return text.replace(/^[ \t]+|[ \t]+$/g, '');
  }

  private static readQuoted(text: string, start: number, no: number): { value: string; end: number } {
    const quote = text[start];
    let value = '';
    let index = start + 1;
    while (index < text.length) {
      const char = text[index] as string;
      if (quote === "'") {
        if (char === "'") {
          if (text[index + 1] === "'") {
            value += "'";
            index += 2;
            continue;
          }
          return { value, end: index + 1 };
        }
        value += char;
        index += 1;
        continue;
      }
      if (char === '"') {
        return { value, end: index + 1 };
      }
      if (char === '\\') {
        const escaped = YamlSubset.readEscape(text, index, no);
        value += escaped.value;
        index = escaped.end;
        continue;
      }
      value += char;
      index += 1;
    }
    throw new YamlSubsetError(no, 'строка в кавычках не закрыта на той же строке');
  }

  private static readEscape(text: string, at: number, no: number): { value: string; end: number } {
    const code = text[at + 1] ?? '';
    const simple: Record<string, string> = {
      '\\': '\\',
      '"': '"',
      '/': '/',
      n: '\n',
      t: '\t',
      r: '\r',
      '0': '\0',
      ' ': ' ',
    };
    const mapped = Object.hasOwn(simple, code) ? simple[code] : undefined;
    if (mapped !== undefined) {
      return { value: mapped, end: at + 2 };
    }
    const width = code === 'x' ? 2 : code === 'u' ? 4 : code === 'U' ? 8 : 0;
    const hex = text.slice(at + 2, at + 2 + width);
    if (width === 0 || !new RegExp(`^[0-9a-fA-F]{${width}}$`).test(hex)) {
      throw new YamlSubsetError(no, `неизвестная escape-последовательность \\${code}`);
    }
    const point = Number.parseInt(hex, 16);
    if (point > 0x10ffff) {
      throw new YamlSubsetError(no, `escape-последовательность \\${code}${hex} вне Unicode`);
    }
    return { value: String.fromCodePoint(point), end: at + 2 + width };
  }

  private static readFlow(text: string, start: number, no: number): { value: YamlValue; end: number } {
    const open = text[start];
    const close = open === '{' ? '}' : ']';
    const mapping: { [key: string]: YamlValue } = Object.create(null);
    const sequence: YamlValue[] = [];
    let index = YamlSubset.skipSpaces(text, start + 1, no);
    if (text[index] === close) {
      return { value: open === '{' ? mapping : sequence, end: index + 1 };
    }
    for (;;) {
      if (open === '{') {
        const key = YamlSubset.readFlowScalar(text, index, no, true);
        index = YamlSubset.skipSpaces(text, key.end, no);
        if (text[index] !== ':') {
          throw new YamlSubsetError(no, 'во flow-отображении ожидалось «:»');
        }
        if (typeof key.value !== 'string' || key.empty) {
          throw new YamlSubsetError(no, 'ключ flow-отображения — не строка');
        }
        const name = YamlSubset.checkKey(key.value, key.quoted, no);
        if (name in mapping) {
          throw new YamlSubsetError(no, `ключ «${name}» повторён`);
        }
        index = YamlSubset.skipSpaces(text, index + 1, no);
        const item = YamlSubset.readFlowValue(text, index, no);
        mapping[name] = item.value;
        index = YamlSubset.skipSpaces(text, item.end, no);
      } else {
        const item = YamlSubset.readFlowValue(text, index, no);
        if (item.empty) {
          throw new YamlSubsetError(no, 'пустой элемент flow-списка');
        }
        sequence.push(item.value);
        index = YamlSubset.skipSpaces(text, item.end, no);
      }
      if (text[index] === ',') {
        index = YamlSubset.skipSpaces(text, index + 1, no);
        // Запятая перед закрывающей скобкой допустима в YAML и ничего не добавляет.
        if (text[index] === close) {
          return { value: open === '{' ? mapping : sequence, end: index + 1 };
        }
        continue;
      }
      if (text[index] === close) {
        return { value: open === '{' ? mapping : sequence, end: index + 1 };
      }
      throw new YamlSubsetError(no, `flow-коллекция не закрыта «${close}» на той же строке`);
    }
  }

  private static readFlowValue(
    text: string,
    start: number,
    no: number,
  ): { value: YamlValue; end: number; empty: boolean } {
    const first = text[start];
    if (first === '{' || first === '[') {
      return { ...YamlSubset.readFlow(text, start, no), empty: false };
    }
    const scalar = YamlSubset.readFlowScalar(text, start, no, false);
    return { value: scalar.value, end: scalar.end, empty: scalar.empty };
  }

  private static readFlowScalar(
    text: string,
    start: number,
    no: number,
    asKey: boolean,
  ): { value: YamlValue; end: number; quoted: boolean; empty: boolean } {
    const first = text[start] ?? '';
    if (first === "'" || first === '"') {
      return { ...YamlSubset.readQuoted(text, start, no), quoted: true, empty: false };
    }
    if (
      YamlSubset.RESERVED_START.has(first) ||
      first === '#' ||
      /^[-?:](?:[ \t,\]}]|$)/.test(text.slice(start))
    ) {
      throw new YamlSubsetError(no, `значение, начинающееся с «${first}», не поддерживается`);
    }
    let index = start;
    while (index < text.length) {
      const char = text[index] as string;
      if (char === ',' || char === '}' || char === ']' || char === '{' || char === '[') {
        break;
      }
      if (char === ':' && /[ \t,}\]]/.test(text[index + 1] ?? ' ')) {
        break;
      }
      if (char === '#' && (text[index - 1] === ' ' || text[index - 1] === '\t')) {
        throw new YamlSubsetError(no, 'комментарий внутри flow-коллекции не поддерживается');
      }
      index += 1;
    }
    const raw = text.slice(start, index);
    if (raw.includes('\t')) {
      throw new YamlSubsetError(no, 'табуляция внутри flow-коллекции: разборщики читают её по-разному');
    }
    const plain = YamlSubset.trimSpaces(raw);
    return {
      value: asKey ? plain : YamlSubset.resolvePlain(plain, no),
      end: index,
      quoted: false,
      empty: plain === '',
    };
  }

  /** Пробелы между элементами flow-коллекции; табуляция там — отказ (pnpm 12 её не принимает). */
  private static skipSpaces(text: string, index: number, no: number): number {
    let at = index;
    while (text[at] === ' ' || text[at] === '\t') {
      if (text[at] === '\t') {
        throw new YamlSubsetError(no, 'табуляция внутри flow-коллекции: разборщики читают её по-разному');
      }
      at += 1;
    }
    return at;
  }
}
