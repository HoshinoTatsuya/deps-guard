import { InputUnreadableError } from '../input-unreadable.error';
import { RcFile } from './rc-file';

/**
 * `.npmrc` (ini, как его читает пакет `ini` у npm, pnpm до 11 и yarn 1) и
 * `.yarnrc` (формат yarn 1): нужные ключи верхнего уровня — так, как их видит
 * менеджер; формы, которые менеджеры читают по-разному, — отказ.
 */
const WANTED = new Set(['ignore-scripts', 'registry', '@scope:registry']);
const wanted = (key: string): boolean => WANTED.has(key);

const npmrc = (text: string): Record<string, [string, number]> =>
  Object.fromEntries(
    [...RcFile.parse(text, '.npmrc', wanted)].map(([key, { value, line }]) => [key, [value, line]]),
  );

const yarnrc = (text: string): Record<string, [string, number]> =>
  Object.fromEntries(
    [...RcFile.parse(text, '.yarnrc', wanted)].map(([key, { value, line }]) => [key, [value, line]]),
  );

const refusal = (read: () => unknown): InputUnreadableError => {
  let error: unknown;
  try {
    read();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(InputUnreadableError);
  return error as InputUnreadableError;
};

describe('RcFile: .npmrc', () => {
  it.each([
    ['ключ = значение', 'registry=https://r.example/\n', { registry: ['https://r.example/', 1] }],
    ['пробелы вокруг «=»', '  registry =  https://r.example/  \n', { registry: ['https://r.example/', 1] }],
    ['ключ в двойных кавычках', '"registry"=https://r.example/\n', { registry: ['https://r.example/', 1] }],
    [
      'значение в двойных кавычках',
      'registry="https://r.example/"\n',
      { registry: ['https://r.example/', 1] },
    ],
    [
      'значение в одинарных кавычках',
      "registry='https://r.example/'\n",
      { registry: ['https://r.example/', 1] },
    ],
    ['ключ без «=» — true', 'ignore-scripts\n', { 'ignore-scripts': ['true', 1] }],
    ['хвост после «;» — комментарий', 'ignore-scripts=true ; пояснение\n', { 'ignore-scripts': ['true', 1] }],
    ['хвост после «#» — комментарий', 'ignore-scripts=true#x\n', { 'ignore-scripts': ['true', 1] }],
    [
      'экранированный «;» — знак',
      'registry=https://r.example/a\\;b\n',
      { registry: ['https://r.example/a;b', 1] },
    ],
    [
      'повтор — последний',
      'registry=https://a.example/\nregistry=https://b.example/\n',
      { registry: ['https://b.example/', 2] },
    ],
    ['строка-комментарий «;» и «#»', ';registry=https://a.example/\n  # registry=https://b.example/\n', {}],
    [
      'одиночный CR делит строки, как у ini',
      'x=1\rregistry=https://evil.example/\n',
      { registry: ['https://evil.example/', 2] },
    ],
    ['CRLF', 'x=1\r\nregistry=https://r.example/\r\n', { registry: ['https://r.example/', 2] }],
    ['ключ scope', '@scope:registry=https://s.example/\n', { '@scope:registry': ['https://s.example/', 1] }],
    [
      'ключ перед секцией читается',
      'registry=https://r.example/\n[ci]\nother=1\n',
      { registry: ['https://r.example/', 1] },
    ],
  ])('%s', (_name, text, expected) => {
    expect(npmrc(text)).toEqual(expected);
  });

  it.each([
    ['ignore-scripts в секции', 'ignore-scripts=false\n[ci]\nignore-scripts=true\n', 3],
    ['registry в секции', 'registry=https://registry.npmjs.org/\n[x]\nregistry=https://evil.example/\n', 3],
    ['секция с отступом', '  [ci]\nregistry=https://evil.example/\n', 2],
    ['ключ-массив', 'registry[]=https://a.example/\n', 1],
  ])('%s — отказ с номером строки: менеджеры читают по-разному', (_name, text, line) => {
    const error = refusal(() => npmrc(text));
    expect(error.path).toBe('.npmrc');
    expect(error.line).toBe(line);
  });

  it('не нужные ключи (токены) не разбираются и не возвращаются, даже в секции и не по формату', () => {
    const secret = 'npm_SECRETVALUE0123456789';
    const text = [
      `//registry.npmjs.org/:_authToken=${secret}`,
      `_auth=${secret}`,
      `"//h.example/:_password"="${secret}"`,
      '[section]',
      `//other.example/:_authToken=${secret}`,
      `${secret}`,
    ].join('\n');
    const result = RcFile.parse(text, '.npmrc', wanted);
    expect([...result.keys()]).toEqual([]);
    expect(JSON.stringify([...result])).not.toContain(secret);
  });
});

describe('RcFile: .yarnrc', () => {
  it.each([
    ['ключ значение', 'ignore-scripts true\n', { 'ignore-scripts': ['true', 1] }],
    ['ключ в кавычках', '"ignore-scripts" true\n', { 'ignore-scripts': ['true', 1] }],
    ['ключ с «--»', '--ignore-scripts true\n', { 'ignore-scripts': ['true', 1] }],
    ['значение в кавычках', 'registry "https://r.example/"\n', { registry: ['https://r.example/', 1] }],
    ['комментарий в конце', 'ignore-scripts true # пояснение\n', { 'ignore-scripts': ['true', 1] }],
    ['повтор — последний', 'ignore-scripts false\nignore-scripts true\n', { 'ignore-scripts': ['true', 2] }],
    ['строка-комментарий', '# ignore-scripts true\n', {}],
    ['вложенный блок без нужных ключей', 'ci:\n  other true\n', {}],
  ])('%s', (_name, text, expected) => {
    expect(yarnrc(text)).toEqual(expected);
  });

  it.each([
    ['вложенный ключ под «ci:»', 'ci:\n  ignore-scripts true\n', 2],
    ['ключ с отступом', '  registry "https://evil.example/"\n', 1],
    ['ключ без значения', 'ignore-scripts\n', 1],
    ['«ключ: значение»', 'registry: "https://evil.example/"\n', 1],
    ['лишний текст после значения', 'ignore-scripts true false\n', 1],
  ])('%s — отказ с номером строки', (_name, text, line) => {
    const error = refusal(() => yarnrc(text));
    expect(error.path).toBe('.yarnrc');
    expect(error.line).toBe(line);
  });

  /** yarn 1 читает .yarnrc с BOM (проба: `yarn config get registry` отдаёт значение первой строки). */
  it('BOM в начале файла — не отступ: первая строка читается', () => {
    expect([
      ...RcFile.parse('\uFEFFregistry "https://r.example/"\n', '.yarnrc', (key) => key === 'registry'),
    ]).toEqual([['registry', { value: 'https://r.example/', line: 1 }]]);
  });
});
