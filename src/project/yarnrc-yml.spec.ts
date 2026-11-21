import { InputUnreadableError } from '../input-unreadable.error';
import { TempDir } from '../testing/temp-dir';
import { YarnrcYml } from './yarnrc-yml';

/** `.yarnrc.yml`: булево — как приводит yarn 2+ (true/1, false/0), иное — отказ; `${…}` — из окружения. */
describe('YarnrcYml', () => {
  let dir: string;

  beforeEach(() => {
    dir = TempDir.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  const flag = (text: string) => {
    TempDir.write(dir, { '.yarnrc.yml': text });
    return YarnrcYml.flag(YarnrcYml.read(dir), 'enableScripts');
  };

  it.each([
    ['enableScripts: true\n', true],
    ['enableScripts: "true"\n', true],
    ['enableScripts: 1\n', true],
    ['enableScripts: false\n', false],
    ["enableScripts: 'false'\n", false],
    ['enableScripts: 0\n', false],
    [`enableScripts: "${'$'}{CI_SCRIPTS:-false}"\n`, 'env'],
    ['other: 1\n', undefined],
  ])('%j → %s', (text, expected) => {
    expect(flag(text)).toBe(expected);
  });

  it.each([
    'enableScripts: False\n',
    'enableScripts: yes\n',
    'enableScripts:\n',
    'enableScripts: [false]\n',
    'enableScripts: null\n',
  ])('%j — отказ со строкой (yarn такое не приводит к булеву)', (text) => {
    let error: unknown;
    try {
      flag(text);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InputUnreadableError);
    expect((error as InputUnreadableError).line).toBe(1);
  });

  it('нет файла — undefined; не отображение и YAML вне подмножества — отказ', () => {
    expect(YarnrcYml.read(dir)).toBeUndefined();
    expect(YarnrcYml.flag(undefined, 'enableScripts')).toBeUndefined();
    TempDir.write(dir, { '.yarnrc.yml': '- a\n' });
    expect(() => YarnrcYml.read(dir)).toThrow(InputUnreadableError);
    TempDir.write(dir, { '.yarnrc.yml': 'enableScripts:\tfalse\n' });
    expect(() => YarnrcYml.read(dir)).toThrow(InputUnreadableError);
  });
});
