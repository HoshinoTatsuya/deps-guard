import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dump, FAILSAFE_SCHEMA, loadAll } from 'js-yaml';
import { parseAllDocuments } from 'yaml';

import { TempDir } from '../testing/temp-dir';
import { FlowDepth } from './flow-depth';
import { YamlSubset } from './yaml-subset';
import { YamlSubsetError } from './yaml-subset.error';

/** Числа эталонных разборщиков — строки: подмножество не превращает версии в числа. */
const normalize = (value: unknown): unknown => {
  if (typeof value === 'number') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, normalize(inner)]));
  }
  return value;
};

const reference = (text: string): unknown[] =>
  parseAllDocuments(text)
    .map((document) => normalize(document.toJS()))
    .filter((value) => value !== null);

/** Так читает lock-файл и настройки менеджер пакетов (js-yaml, схема по умолчанию: со слиянием `<<`). */
const manager = (text: string): unknown[] =>
  loadAll(text)
    .map(normalize)
    .filter((value) => value !== null && value !== undefined);

const mine = (text: string): unknown[] =>
  YamlSubset.parseAll(text).map((document) => normalize(document.value));

/** Так pnpm пишет lock-файл. */
const pnpmDump = (value: unknown): string =>
  dump(value, { lineWidth: 1000, noCompatMode: true, noRefs: true, sortKeys: false });

const char = (code: number): string => String.fromCharCode(code);

describe('YamlSubset', () => {
  it('блочные отображения, последовательности, flow, кавычки, комментарии, несколько документов', () => {
    const text = [
      '---',
      "lockfileVersion: '9.0'",
      '# комментарий',
      'settings:',
      '  autoInstallPeers: true   # хвост',
      'packages:',
      "  - '.'",
      '  - name: a',
      "    version: '1.10'",
      "'@scope/x@1.0.0':",
      "  resolution: {integrity: sha512-abc==, tarball: 'http://h/x.tgz'}",
      '  cpu: [arm64, x64]',
      '  empty: {}',
      '  quoted: "a\\tb \\u00e9"',
      "  single: 'it''s'",
      '  nothing:',
      '---',
      'second: doc',
      '',
    ].join('\n');
    expect(mine(text)).toEqual(reference(text));
    expect(mine(text)).toEqual(manager(text));
    const first = YamlSubset.parseAll(text)[0]?.value as Record<string, Record<string, unknown>>;
    expect(first['@scope/x@1.0.0']?.quoted).toBe(`a\tb ${char(0xe9)}`);
    expect((first.packages as unknown as Array<Record<string, string>>)[1]?.version).toBe('1.10');
  });

  it('номер строки ключа', () => {
    const document = YamlSubset.parse('a:\n  b: 1\n  c: 2\n');
    const a = (document.value as Record<string, object>).a as object;
    expect(document.lineOf(a, 'c')).toBe(3);
    expect(document.lineOf(a, 'zzz')).toBeUndefined();
  });

  it('формы сериализатора pnpm: ключ длиннее 1024 знаков («? … / : …») и многострочный deprecated («|-», «|2-», «|+», «>-»)', () => {
    const peers = Array.from(
      { length: 40 },
      (_, index) => `(@scope/peer-package-number-${index}@11.1.29)`,
    ).join('');
    const lock = {
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { a: { specifier: '1.0.0', version: '1.0.0' } } } },
      packages: {
        'a@1.0.0': {
          resolution: { integrity: 'sha512-AAAA' },
          deprecated: 'Deprecated due to a bug, see\n  https://example.com/issue.\n\n# не комментарий',
        },
        'b@1.0.0': {
          resolution: { integrity: 'sha512-BBBB' },
          deprecated: '  с пробелом в начале\nи дальше',
        },
        'c@1.0.0': { resolution: { integrity: 'sha512-CCCC' }, deprecated: 'хвост\n\n' },
        'd@1.0.0': { resolution: { integrity: 'sha512-DDDD' }, deprecated: `${'x'.repeat(1100)} конец` },
      },
      snapshots: {
        [`a@1.0.0${peers}`]: { dependencies: { b: '1.0.0' } },
        [`b@1.0.0${peers}`]: {},
        [`c@1.0.0${peers}`]: { optional: true },
      },
    };
    const text = pnpmDump(lock);
    // Без этих форм проверка была бы о другом: сериализатор обязан их выдать.
    expect(text).toMatch(/^ {2}\? a@1\.0\.0\(/m);
    expect(text).toMatch(/^ {2}: dependencies:$/m);
    expect(text).toContain('deprecated: |-\n');
    expect(text).toContain('deprecated: |2-\n');
    expect(text).toContain('deprecated: |+\n');
    expect(text).toContain('deprecated: >-\n');
    expect(mine(text)).toEqual(manager(text));
    expect(mine(text)).toEqual([normalize(lock)]);
    const document = YamlSubset.parse(text);
    const snapshots = (document.value as Record<string, object>).snapshots as object;
    expect(text.split('\n')[(document.lineOf(snapshots, `a@1.0.0${peers}`) as number) - 1]).toMatch(
      /^ {2}\? /,
    );
  });

  it.each([
    [
      'lock-файл после prettier: «{» и «}» на своих строках',
      "packages:\n  '@b/g@7.28.3':\n    resolution:\n      {\n        integrity: sha512-x==,\n      }\n    engines: { node: '>=6.9.0' }\n",
    ],
    ['начата на строке ключа', 'a: {\n    x: 1,\n    y: [1,\n     2]\n  }\nb: 2\n'],
    ['в элементе последовательности', 'l:\n  - {\n    a: 1 }\n  - [x,\n    w]\n  -\n    {\n      z: 1 }\n'],
    ['скаляр без кавычек через перевод строки', 'a: { b: c\n  d }\n'],
  ])('многострочная flow-коллекция (%s) читается как у js-yaml', (_name, text) => {
    expect(mine(text)).toEqual(manager(text));
    expect(mine(text)).toEqual(reference(text));
  });

  it.each([
    ['пустая строка внутри', 'a: {\n\n b: 1 }\n'],
    ['комментарий внутри', 'a: {\n# c\n b: 1 }\n'],
    ['строка в кавычках через перевод строки', "a: { b: 'x\n  y' }\n"],
    ['содержимое без отступа от родителя', 'a: {\n  x: 1,\ny: 2\n  }\n'],
    ['не закрыта до конца документа', 'a: {\n  x: 1\n'],
  ])('многострочная flow-коллекция: %s — отказ', (_name, text) => {
    expect(() => YamlSubset.parseAll(text)).toThrow(YamlSubsetError);
  });

  it.each([
    ['литеральный', 'a: |\n  x\n   y\n\n  z\nb: 1\n'],
    ['литеральный без хвоста', 'a: |-\n  x\n\n\nb: 1\n'],
    ['литеральный с хвостом', 'a: |+\n  x\n\n\nb: 1\n'],
    ['сохранение в конце файла', 'a: |+\n  x\n\n'],
    ['без перевода строки в конце', 'a: |\n  x'],
    ['индикатор отступа', 'a: |2\n   x\n  y\n'],
    ['индикатор отступа во вложенном', 'a:\n  b: |1-\n    x\n   y\n'],
    ['ведущие пустые строки', 'a: |\n\n\n  x\n'],
    ['комментарий в заголовке', 'a: |- # пояснение\n  x\n'],
    ['«#» внутри — текст', 'a: |\n  # x\n  y\nb: 1\n'],
    ['табуляция после отступа', 'a: |\n  \tx\n'],
    ['пустой', 'a: |\nb: 1\n'],
    ['пустой с сохранением', 'a: |+\n\n\nb: 1\n'],
    ['свёрнутый', 'a: >\n  x\n  y\n\n  z\n   w\n  v\n'],
    ['свёрнутый без хвоста', 'a: >-\n  x\n  y\n'],
    ['свёрнутый с ведущей пустой', 'a: >\n\n  x\n  y\n'],
    ['свёрнутый со строкой с бо́льшим отступом', 'a: >\n  x\n   y\n  z\n\n   w\n'],
    ['в компактном отображении последовательности', 'l:\n  - a: |\n      x\n    b: 1\n'],
  ])('блочный скаляр (%s) читается как у js-yaml и YAML 1.2', (_name, text) => {
    expect(mine(text)).toEqual(manager(text));
    expect(mine(text)).toEqual(reference(text));
  });

  it.each([
    ['якорь', 'a: &x 1\n'],
    ['ссылка', 'a: *x\n'],
    ['тег', 'a: !!str 1\n'],
    ['многострочный скаляр', 'a: one\n  two\n'],
    ['повтор ключа', 'a: 1\na: 2\n'],
    ['повтор ключа в кавычках и без', "'a': 1\na: 2\n"],
    ['повтор ключа через escape', '"a": 1\n"\\x61": 2\n'],
    ['табуляция в отступе', 'a:\n\tb: 1\n'],
    ['незакрытая кавычка', "a: 'x\n"],
    ['незакрытая flow-коллекция', 'a: {b: 1\nc: 2\n'],
    ['лишний отступ', 'a:\n    b: 1\n  c: 2\n'],
    ['скаляр с двоеточием', 'a: b: c\n'],
    ['неизвестная escape', 'a: "\\q"\n'],
    ['пустой элемент flow-списка', 'a: [x, , w]\n'],
    ['блочный скаляр в элементе последовательности', 'a:\n  - |\n    x\n'],
    ['пустая строка с отступом больше содержимого', 'a: |\n     \n  x\n'],
    ['неразобранный заголовок блочного скаляра', 'a: |x\n  y\n'],
    ['явный ключ без значения', '? a\nb: 1\n'],
    ['явный ключ — коллекция', '? [a]\n: 1\n'],
    ['первая строка блочного скаляра глубже следующих', 'a: >\n   x\n  y\n'],
  ])('%s — отказ с номером строки, а не пропуск', (_name, text) => {
    expect(() => YamlSubset.parseAll(text)).toThrow(YamlSubsetError);
  });

  /**
   * Входы, которые разборщики читают по-разному. Подмножество обязано либо
   * отказать, либо прочесть так же, как менеджер пакетов: принятый и прочитанный
   * иначе вход — это пакет, который гейт видит не там, откуда его ставят.
   */
  const hostile: ReadonlyArray<[string, string, 'refuse' | 'same']> = [
    ['одиночный CR после комментария прячет ключ', `a: 1\n# c${char(13)}b: 2\n`, 'refuse'],
    ['одиночный CR после хвостового комментария', `a: 1 # c${char(13)}b: 2\n`, 'refuse'],
    ['ключ слияния в блоке', 'r:\n  integrity: sha512-x\n  <<: {tarball: https://evil/x.tgz}\n', 'refuse'],
    ['ключ слияния во flow', 'r: {integrity: sha512-x, <<: {tarball: https://evil/x.tgz}}\n', 'refuse'],
    ['ключ слияния в кавычках', "r:\n  '<<': {tarball: https://evil/x.tgz}\n", 'refuse'],
    ['NEL как перевод строки', `a: 1${char(0x85)}b: 2\n`, 'refuse'],
    ['LS U+2028', `a: 1${char(0x2028)}b: 2\n`, 'refuse'],
    ['PS U+2029', `a: 1${char(0x2029)}b: 2\n`, 'refuse'],
    ['BOM в середине', `a: 1\n${char(0xfeff)}b: 2\n`, 'refuse'],
    ['управляющий символ', `a: x${char(1)}y\n`, 'refuse'],
    ['NBSP перед «#» в значении', `a: sha512-AAA${char(0xa0)}#x\n`, 'same'],
    ['NBSP в конце ключа', `lodash${char(0xa0)}: 1\n`, 'same'],
    ['NBSP в конце значения', `a: x${char(0xa0)}\n`, 'same'],
    ['пробел нулевой ширины в ключе', `lo${char(0x200b)}dash: 1\n`, 'same'],
    ['комментарий во flow', 'a: {b: c #d}\n', 'refuse'],
    ['ключ flow без пробела после двоеточия', 'a: {b:c}\n', 'refuse'],
    ['двоеточие в значении flow', 'a: {t: https://x:8080/p}\n', 'same'],
    ['табуляция перед «#»', 'a: x\t#c\n', 'same'],
    ['табуляция после двоеточия', 'a:\t1\n', 'refuse'],
    // Табуляция как разделитель: js-yaml читает её как пробел, pnpm 12 отказывает — общего прочтения нет.
    [
      'табуляция после «:» прячет config-зависимость',
      'configDependencies:\t{bb-lib: 1.0.0+sha512-AAAA}\n',
      'refuse',
    ],
    ['табуляция после «:» у ключа в кавычках', "'a':\t{x: y}\n", 'refuse'],
    ['пробел и табуляция после «:»', 'a: \t{x: y}\n', 'refuse'],
    [
      'табуляция после «? »: ключ остался бы в кавычках',
      '? \t"dangerouslyAllowAllBuilds"\n: true\n',
      'refuse',
    ],
    ['табуляция после «?»', '?\tk\n: v\n', 'refuse'],
    ['табуляция после «: » явного значения', "? k\n: \t'v'\n", 'refuse'],
    ['табуляция после «- »: список прочитан бы строкой', 'a:\n  - \t[b, c]\n', 'refuse'],
    ['табуляция после «- »: кавычки остались бы в значении', "a:\n  - \t'x'\n", 'refuse'],
    ['табуляция после «-»', 'a:\n  -\tx\n', 'refuse'],
    ['табуляция после «:» во flow', 'a: {b:\tc}\n', 'refuse'],
    ['табуляция после «,» во flow: кавычки остались бы в значении', "a: [x,\t'y']\n", 'refuse'],
    ['табуляция перед «,» во flow', 'a: [x\t, w]\n', 'refuse'],
    ['табуляция внутри скаляра во flow', 'a: [x\ty]\n', 'refuse'],
    ['табуляция в заголовке блочного скаляра', 'a: |\t# c\n  t\n', 'refuse'],
    ['табуляция перед «:» ключа', 'a\t: b\n', 'same'],
    ['табуляция внутри скаляра', 'a: x\ty\n', 'same'],
    ['табуляция в конце строки', 'a: 1\t\nb: [x]\t\n', 'same'],
    ['табуляция внутри строки в кавычках', 'a: \'x\ty\'\nb: "x\ty"\n', 'same'],
    ['несколько пробелов после «? » перед ключом в кавычках', "?   'k'\n:   'v'\n", 'same'],
    ['несколько пробелов после «- » перед строкой в кавычках', "a:\n  -   'x'\n", 'same'],
    ['несколько пробелов после «:» перед строкой в кавычках', "a:   'x'\n", 'same'],
    ['запятая в конце flow-списка', 'a: [x, ]\n', 'same'],
    ['запятая в конце flow-отображения', 'a: {b: 1, }\n', 'same'],
    ['явный ключ', '? a\n: 1\n', 'same'],
    ['число 1.10', 'a: 1.10\n', 'refuse'],
    ['число 010', 'a: 010\n', 'refuse'],
    ['число 0x1F', 'a: 0x1F\n', 'refuse'],
    ['число 1e3', 'a: 1e3\n', 'refuse'],
    ['число 1_000', 'a: 1_000\n', 'refuse'],
    ['число +1', 'a: +1\n', 'refuse'],
    ['число .inf', 'a: .inf\n', 'refuse'],
    ['каноническое целое', 'a: 1440\n', 'same'],
    ['отрицательное целое', 'a: -3\n', 'same'],
    ['версия', 'a: 1.0.0\n', 'same'],
    ['ключ True', 'True: 1\n', 'refuse'],
    ['ключ ~', '~: 1\n', 'refuse'],
    ['ключ 1.10', '1.10: a\n', 'refuse'],
    ['ключ 1.0 и 1.00', '1.0: a\n1.00: b\n', 'refuse'],
    ['ключ true', 'true: 1\n', 'same'],
    ['yes — pnpm 12 в булевом поле читает true, js-yaml — строку', 'a: yes\n', 'refuse'],
    ['no', 'a: no\n', 'refuse'],
    ['On', 'a: On\n', 'refuse'],
    ['OFF', 'a: OFF\n', 'refuse'],
    ['y', 'a: [y]\n', 'refuse'],
    ['True — pnpm 12 в строковом поле читает «True», js-yaml — true', 'a: True\n', 'refuse'],
    ['FALSE', 'a: FALSE\n', 'refuse'],
    ['true и false', 'a: true\nb: false\n', 'same'],
    ['yes/no ключом — строки у обоих', 'yes: 1\nno: 2\n', 'same'],
    ['yes в кавычках', "a: 'yes'\n", 'same'],
    ['yesterday', 'a: yesterday\nb: only\n', 'same'],
    ['null-формы', 'a: ~\nb: NULL\nc:\n', 'same'],
    ['маркер конца документа', 'a: 1\n...\n', 'refuse'],
    [
      '«---» вплотную к ключу: js-yaml — маркер документа, YAML 1.2 — ключ',
      '---allowBuilds  esbuild: true\n',
      'refuse',
    ],
    ['метка времени без кавычек (js-yaml — дата)', 'a: 2027-01-13\n', 'refuse'],
    ['метка времени с часами', 'a: 2027-01-13T10:00:00Z\n', 'refuse'],
    ['метка времени ключом', '2027-01-13: a\n', 'refuse'],
    ['метка времени в кавычках', "a: '2027-01-13'\n", 'same'],
    ['похожая на дату версия', 'a: 2027.1.13\nb: 2027-1-x\n', 'same'],
    ['минус ноль (js-yaml — 0)', 'a: -0\n', 'refuse'],
    ['ноль', 'a: 0\nb: -1\n', 'same'],
    ['скаляр начинается с «,»', 'a: ,x\n', 'refuse'],
    ['скаляр начинается с «]»', 'a: ]x\n', 'refuse'],
    ['скаляр начинается с «}»', 'a: }x\n', 'refuse'],
    ['элемент последовательности начинается с «,]»', 'a:\n  - ,]x\n', 'refuse'],
    ['ключ начинается с «,»', ',a: 1\n', 'refuse'],
    ['похоже на true', 'a: truex\nb: xtrue\nc: falsey\nd: nullx\ne: TRUEx\n', 'same'],
    ['escape вне Unicode', 'a: "\\U00110000"\n', 'refuse'],
    ['escape на границе Unicode', 'a: "\\U0010FFFF"\n', 'same'],
    ['ключ с комментарием', 'a #b: 1\n', 'refuse'],
    ['документ с содержимым на строке «---»', '--- a: 1\n', 'refuse'],
    ['многострочная строка в кавычках', "a: 'x\n  y'\n", 'refuse'],
    ['продолжение скаляра без кавычек', 'a: x\n  y\n', 'refuse'],
    ['«#» без пробела — текст', 'a: x#y\n', 'same'],
    ['значение начинается с «- »', 'a: - b\n', 'refuse'],
    ['ключ, начинающийся с «-»', '-a: 1\n', 'same'],
    ['CRLF', 'a: 1\r\nb: 2\r\n', 'same'],
    ['несколько документов', 'a: 1\n---\nb: 2\n', 'same'],
  ];

  it.each(hostile)('%s', (_name, text, expected) => {
    if (expected === 'refuse') {
      expect(() => YamlSubset.parseAll(text)).toThrow(YamlSubsetError);
      return;
    }
    expect(mine(text)).toEqual(manager(text));
  });

  it('всё, что подмножество принимает из враждебных входов, прочитано так же, как у js-yaml', () => {
    const accepted = hostile.filter(([, text]) => {
      try {
        YamlSubset.parseAll(text);
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted.length).toBeGreaterThan(10);
    for (const [name, text] of accepted) {
      expect({ name, value: mine(text) }).toEqual({ name, value: manager(text) });
    }
  });

  it('причина отказа — без номера строки (его ставит вызывающий), номер — отдельно', () => {
    let error: unknown;
    try {
      YamlSubset.parseAll('a: 1\nb: &x 2\n');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(YamlSubsetError);
    expect((error as YamlSubsetError).line).toBe(2);
    expect((error as YamlSubsetError).detail).not.toMatch(/строка/);
    expect((error as YamlSubsetError).message).toBe(`строка 2: ${(error as YamlSubsetError).detail}`);
  });

  it.each([
    ['C1 U+0080', 0x80],
    ['NEL U+0085', 0x85],
    ['C1 U+009F', 0x9f],
    ['DEL U+007F', 0x7f],
    ['LS U+2028', 0x2028],
    ['PS U+2029', 0x2029],
    ['BOM U+FEFF', 0xfeff],
    ['C0 U+0001', 0x01],
  ])('символ %s внутри скаляра — отказ именно из-за символа, с номером строки', (_name, code) => {
    let error: unknown;
    try {
      YamlSubset.parseAll(`a: 1\nb: x${char(code)}y\n`);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(YamlSubsetError);
    expect((error as YamlSubsetError).line).toBe(2);
    expect((error as YamlSubsetError).detail).toContain(
      `U+${code.toString(16).toUpperCase().padStart(4, '0')}`,
    );
  });

  it.each(['{', '[', ']', '}', ',', '&', '*', '!', '|', '>', '%', '@', '`'])(
    'ключ, начинающийся с «%s», — не ключ без кавычек: отказ, а не ключ с этим символом',
    (indicator) => {
      expect(() => YamlSubset.parseAll(`${indicator}a: 1\n`)).toThrow(YamlSubsetError);
    },
  );

  it.each([
    ['закрывающая «]» на отступе родителя', 'packages: [\n  a,\n  b\n]\n'],
    ['закрывающая «}» на отступе родителя', 'catalog: {\n  a: 1.0.0\n}\n'],
    ['вложенная коллекция закрыта левее родителя', 'catalogs:\n  x: {\n    a: 1.0.0\n}\n'],
    [
      'весь документ — JSON на нескольких строках',
      '{\n  "packages": ["a"],\n  "catalog": {"x": "1.0.0"}\n}\n',
    ],
    ['весь документ — JSON в одну строку', '{"packages": ["a"]}\n'],
  ])('flow-коллекция: %s — читается как у js-yaml', (_name, text) => {
    expect(mine(text)).toEqual(manager(text));
  });

  it.each([
    ['содержимое на отступе родителя', 'packages: [a,\nb]\n'],
    ['скобка на отступе родителя не закрывает коллекцию', 'packages: [\n  [a,\n]\n  ]\n'],
  ])('flow-коллекция: %s — отказ (pnpm 12 такое не читает)', (_name, text) => {
    expect(() => YamlSubset.parseAll(text)).toThrow(YamlSubsetError);
  });

  it('многострочная flow-коллекция разбирается за линейное время: каждая строка просматривается один раз', () => {
    const lines = 4000;
    const text = `packages: [\n${Array.from({ length: lines }, (_, i) => `  "packages/p${i}",`).join('\n')}\n  ]\n`;
    const feed = jest.spyOn(FlowDepth.prototype, 'feed');
    const parsed = YamlSubset.parse(text).value as { packages: string[] };
    expect(parsed.packages.length).toBe(lines);
    const scanned = feed.mock.calls.reduce((sum, [piece]) => sum + piece.length, 0);
    // Пересчёт по накопленному тексту дал бы ~lines²/2 знаков, то есть в тысячи раз больше.
    expect(scanned).toBeLessThanOrEqual(text.length * 2);
    expect(feed.mock.calls.length).toBe(lines + 2);
  });

  it('реальные lock-файлы и настройки pnpm: разбор совпадает с эталонным разборщиком и с js-yaml', () => {
    const fixtures = join(TempDir.FIXTURES, 'pnpm-project');
    const files = ['base', 'head'].flatMap((variant) =>
      readdirSync(join(fixtures, variant))
        .filter((name) => name.endsWith('.yaml'))
        .map((name) => join(fixtures, variant, name)),
    );
    files.push(
      join(__dirname, '..', '..', 'pnpm-lock.yaml'),
      join(__dirname, '..', '..', 'pnpm-workspace.yaml'),
    );
    expect(files.length).toBe(6);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect({ file, value: mine(text) }).toEqual({ file, value: reference(text) });
      expect({ file, value: mine(text) }).toEqual({ file, value: manager(text) });
    }
  });

  it.each([
    ['число в другой записи', 'a: 1.10\n', { a: '1.10' }],
    [
      'true, false, null — строки',
      'a: true\nb: false\nc: null\nd: ~\n',
      { a: 'true', b: 'false', c: 'null', d: '~' },
    ],
    ['пустое значение — null', 'a:\n', { a: null }],
    ['пустое значение во flow — null', 'a: {b: }\n', { a: { b: null } }],
    ['дата и yes — строки', 'a: 2027-01-13\nb: yes\nc: -0\n', { a: '2027-01-13', b: 'yes', c: '-0' }],
    ['checksum, похожий на число', `a: 0b08b5${'e4'.repeat(20)}\n`, { a: `0b08b5${'e4'.repeat(20)}` }],
    ['ключ True — строка', 'True: 1\n', { True: '1' }],
  ])('FAILSAFE (yarn 2+): %s — как у js-yaml FAILSAFE', (_name, text, expected) => {
    expect(YamlSubset.parseFailsafe(text).value).toEqual(expected);
    expect(loadAll(text, undefined, { schema: FAILSAFE_SCHEMA, json: true })[0]).toEqual(expected);
  });

  it('FAILSAFE не ослабляет структуру: табуляция-разделитель, якорь, повтор ключа — отказ; схема по умолчанию после — прежняя', () => {
    for (const text of ['a:\t1\n', 'a: &x 1\n', 'a: 1\na: 2\n']) {
      expect(() => YamlSubset.parseFailsafe(text)).toThrow(YamlSubsetError);
    }
    expect(() => YamlSubset.parse('a: 1.10\n')).toThrow(YamlSubsetError);
    expect(YamlSubset.parse('a: true\n').value).toEqual({ a: true });
  });

  it('число 0b/0o/0x — только со своими цифрами (как у js-yaml)', () => {
    expect(() => YamlSubset.parse('a: 0b101\n')).toThrow(YamlSubsetError);
    expect(() => YamlSubset.parse('a: 0o17\n')).toThrow(YamlSubsetError);
    expect(() => YamlSubset.parse('a: 0x1F\n')).toThrow(YamlSubsetError);
    expect(mine('a: 0b2\nb: 0o8\nc: 0xg\n')).toEqual(manager('a: 0b2\nb: 0o8\nc: 0xg\n'));
  });
});
