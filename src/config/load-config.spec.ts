import { InputUnreadableError } from '../input-unreadable.error';
import { TempDir } from '../testing/temp-dir';
import { LoadConfig } from './load-config';

const FULL = {
  lockfile: 'pnpm-lock.yaml',
  disabled: { freshness: 'метаданных реестра нет в изолированной сети' },
  newDependencies: { baseline: { gitRef: 'origin/main' }, allow: { a: 'причина' } },
  installScripts: { allow: {}, othersBlockedBy: 'npm ci --ignore-scripts в CI' },
  sources: {
    registries: ['https://registry.npmjs.org/'],
    defaultRegistry: 'https://registry.npmjs.org/',
    allow: {},
  },
  typosquatting: { popularFile: 'popular.json', allow: {} },
  freshness: { minAgeDays: 3, metadataFile: 'meta.json', allow: {} },
  floatingRanges: { forbid: ['caret', 'tag'], fields: ['devDependencies'], allow: {} },
  bannedPackages: [
    { name: 'old-orm', reason: 'заменён другой библиотекой, возврат запрещён' },
    { name: '@scope/legacy.kit', reason: 'снят с поддержки, замена уже в проекте' },
    { name: 'JSONStream', reason: 'старое имя реестра с заглавными — тоже имя' },
  ],
};

const BANNED_REASON = 'заменён другой библиотекой, возврат запрещён';

describe('LoadConfig', () => {
  it('полная настройка принимается как есть', () => {
    expect(LoadConfig.validate(FULL)).toEqual(FULL);
  });

  it.each([
    ['неизвестный раздел', { source: {} }, 'неизвестный ключ «source»'],
    ['неизвестный ключ раздела', { sources: { registry: [] } }, 'неизвестный ключ «registry»'],
    ['неизвестное правило в disabled', { disabled: { everything: 'x' } }, 'неизвестный ключ «everything»'],
    [
      'отключение чтения входов',
      { disabled: { input: 'входы читать не нужно, хватит правил' } },
      'неизвестный ключ «input»',
    ],
    ['реестр не http(s)', { sources: { registries: ['ftp://x/'] } }, 'ожидался адрес http(s)'],
    ['реестры не массив', { sources: { registries: 'https://x/' } }, 'ожидался массив'],
    [
      'база с двумя ключами',
      { newDependencies: { baseline: { gitRef: 'a', file: 'b' } } },
      'ровно один ключ',
    ],
    ['отрицательный порог', { freshness: { minAgeDays: -1 } }, 'неотрицательное'],
    ['неизвестный вид диапазона', { floatingRanges: { forbid: ['caret', 'loose'] } }, 'ожидался массив из'],
    ['причина не строка', { typosquatting: { allow: { x: 1 } } }, 'ожидалась непустая строка'],
    ['корень не объект', [], 'ожидался объект'],
    ['bannedPackages не массив', { bannedPackages: { 'old-orm': BANNED_REASON } }, 'ожидался массив записей'],
    ['запрет без причины', { bannedPackages: [{ name: 'old-orm' }] }, 'bannedPackages[0].reason'],
    ['запрет с пустой причиной', { bannedPackages: [{ name: 'old-orm', reason: '   ' }] }, 'причина запрета'],
    [
      'запрет с короткой причиной',
      { bannedPackages: [{ name: 'old-orm', reason: 'не нужен' }] },
      'не короче 30',
    ],
    ['запрет без имени', { bannedPackages: [{ reason: BANNED_REASON }] }, 'bannedPackages[0].name'],
    [
      'имя с версией',
      { bannedPackages: [{ name: 'old-orm@1.0.0', reason: BANNED_REASON }] },
      'имя пакета реестра',
    ],
    [
      'имя с диапазоном',
      { bannedPackages: [{ name: 'old-orm ^1', reason: BANNED_REASON }] },
      'имя пакета реестра',
    ],
    [
      'scope без имени',
      { bannedPackages: [{ name: '@scope', reason: BANNED_REASON }] },
      'имя пакета реестра',
    ],
    [
      'scope с заглавной',
      { bannedPackages: [{ name: '@Scope/x', reason: BANNED_REASON }] },
      'имя пакета реестра',
    ],
    ['имя с точки', { bannedPackages: [{ name: '.hidden', reason: BANNED_REASON }] }, 'имя пакета реестра'],
    ['имя путём', { bannedPackages: [{ name: '../x', reason: BANNED_REASON }] }, 'имя пакета реестра'],
    ['пустое имя', { bannedPackages: [{ name: '', reason: BANNED_REASON }] }, 'имя пакета реестра'],
    ['имя не строка', { bannedPackages: [{ name: 1, reason: BANNED_REASON }] }, 'имя пакета реестра'],
    [
      'имя длиннее 214',
      { bannedPackages: [{ name: 'x'.repeat(215), reason: BANNED_REASON }] },
      'имя пакета реестра',
    ],
    ['запись не объект', { bannedPackages: ['old-orm'] }, 'bannedPackages[0]: ожидался объект'],
    [
      'лишний ключ записи',
      { bannedPackages: [{ name: 'old-orm', reason: BANNED_REASON, version: '1' }] },
      'неизвестный ключ «version»',
    ],
    [
      'повтор имени',
      {
        bannedPackages: [
          { name: 'old-orm', reason: BANNED_REASON },
          { name: 'old-orm', reason: BANNED_REASON },
        ],
      },
      'bannedPackages[1].name: «old-orm» уже в перечне',
    ],
  ])('%s — отказ', (_name, value, message) => {
    expect(() => LoadConfig.validate(value)).toThrow(InputUnreadableError);
    expect(() => LoadConfig.validate(value)).toThrow(message);
  });

  it('пустой перечень запретов и имя ровно 214 знаков принимаются', () => {
    expect(LoadConfig.validate({ bannedPackages: [] })).toEqual({ bannedPackages: [] });
    const longest = { bannedPackages: [{ name: 'x'.repeat(214), reason: BANNED_REASON }] };
    expect(LoadConfig.validate(longest)).toEqual(longest);
  });

  it('нет файла или битый JSON — отказ, а не значения по умолчанию', () => {
    const dir = TempDir.create();
    try {
      expect(() => LoadConfig.fromRoot(dir)).toThrow('настройка не прочитана');
      TempDir.write(dir, { 'deps-guard.json': '{' });
      expect(() => LoadConfig.fromRoot(dir)).toThrow('не JSON');
      TempDir.write(dir, { 'deps-guard.json': '{}' });
      expect(LoadConfig.fromRoot(dir)).toEqual({});
    } finally {
      TempDir.remove(dir);
    }
  });
});
