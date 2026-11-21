import { createHash } from 'node:crypto';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import { TempDir } from '../testing/temp-dir';
import { YarnToolchain } from './yarn-toolchain';

/**
 * `.yarnrc.yml` yarn 2+: `yarnPath` и `plugins` — код из репозитория, который
 * исполняет любая команда yarn (замер на yarn 4.0.2 и 3.4.1), и зависимости
 * `packageExtensions` — предметы новой зависимости.
 */
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('YarnToolchain', () => {
  let dir: string;

  beforeEach(() => {
    dir = TempDir.create({
      '.yarn/releases/yarn-4.0.2.cjs': 'yarn',
      '.yarn/plugins/a.cjs': 'plugin a',
      'plug.cjs': 'plugin b',
    });
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  const entries = (yml: string) => {
    TempDir.write(dir, { '.yarnrc.yml': yml });
    return YarnToolchain.onDisk(dir).map((entry) => [entry.name, entry.line]);
  };

  const refusal = (yml: string): InputUnreadableError => {
    let error: unknown;
    try {
      entries(yml);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InputUnreadableError);
    return error as InputUnreadableError;
  };

  it('yarnPath, плагины (строкой и path:), зависимости packageExtensions — предметы с путём, хэшем и строкой', () => {
    expect(
      entries(
        [
          'yarnPath: .yarn/releases/yarn-4.0.2.cjs',
          'plugins:',
          '  - path: .yarn/plugins/a.cjs',
          '    spec: "@yarnpkg/plugin-a"',
          '  - ./plug.cjs',
          'packageExtensions:',
          '  "aa-lib@*":',
          '    dependencies:',
          '      bb-lib: "1.0.0"',
          '      cc: "https://h.example/cc.tgz"',
          '    peerDependencies:',
          '      react: "*"',
          '',
        ].join('\n'),
      ),
    ).toEqual([
      [`yarnPath@.yarn/releases/yarn-4.0.2.cjs#sha256=${sha('yarn')}`, 1],
      [`plugin@.yarn/plugins/a.cjs#sha256=${sha('plugin a')}`, 2],
      [`plugin@plug.cjs#sha256=${sha('plugin b')}`, 2],
      ['bb-lib', 9],
      ['cc@https://h.example/cc.tgz', 10],
    ]);
  });

  it('смена содержимого файла — другой предмет; нет .yarnrc.yml — нет предметов', () => {
    const before = entries('yarnPath: .yarn/releases/yarn-4.0.2.cjs\n');
    TempDir.write(dir, { '.yarn/releases/yarn-4.0.2.cjs': 'yarn с подменой' });
    expect(YarnToolchain.onDisk(dir).map((entry) => entry.name)).not.toEqual(before.map(([name]) => name));
    TempDir.remove(dir);
    dir = TempDir.create();
    expect(YarnToolchain.onDisk(dir)).toEqual([]);
  });

  it.each([
    ['yarnPath вне репозитория', 'yarnPath: ../yarn.cjs\n', 1],
    ['yarnPath абсолютный', 'yarnPath: /usr/lib/yarn.cjs\n', 1],
    ['yarnPath — нет файла', 'yarnPath: .yarn/releases/none.cjs\n', 1],
    ['плагин без path, по адресу', 'plugins:\n  - spec: "https://h.example/p.js"\n', 1],
    ['плагин не по форме', 'plugins:\n  - {a: b}\n', 1],
    ['plugins не список', 'plugins: x\n', 1],
    [
      'packageExtensions: неизвестное поле',
      'packageExtensions:\n  "a@*":\n    scripts:\n      postinstall: x\n',
      2,
    ],
    [
      'packageExtensions: зависимость не строка',
      'packageExtensions:\n  "a@*":\n    dependencies:\n      b: [1]\n',
      4,
    ],
  ])('%s — «не прочитано» со строкой', (_name, yml, line) => {
    const error = refusal(yml);
    expect(error.path).toBe('.yarnrc.yml');
    expect(error.line).toBe(line);
  });

  it.each(['yarnPath: ../yarn.cjs\n', 'yarnPath: /usr/lib/yarn.cjs\n', 'plugins:\n  - ../p.cjs\n'])(
    '%j — отказ именно «вне репозитория», без попытки читать файл',
    (yml) => {
      expect(refusal(yml).message).toMatch(/вне репозитория: гейт его не видит$/);
    },
  );

  it('ссылка на файл вне корня — не прочитан', () => {
    const outside = TempDir.create({ 'yarn.cjs': 'чужой код' });
    try {
      symlinkSync(join(outside, 'yarn.cjs'), join(dir, 'linked.cjs'));
      expect(refusal('yarnPath: linked.cjs\n').message).toContain('не прочитан');
    } finally {
      TempDir.remove(outside);
    }
  });
});
