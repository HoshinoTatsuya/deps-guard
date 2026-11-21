import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GreenProject } from '../testing/green-project';
import { TempDir } from '../testing/temp-dir';
import { Cli } from './cli';

/** CLI в процессе: разбор `--now` и опорное время в отчёте. */
describe('Cli check --now', () => {
  let dir: string;

  beforeEach(() => {
    dir = GreenProject.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  const CLOCK = new Date('2026-11-16T12:00:00Z');

  const run = async (now: string): Promise<{ code: number; out: string; err: string }> => {
    let out = '';
    let err = '';
    const code = await Cli.main(['check', '--root', dir, '--now', now], {
      cwd: dir,
      env: {},
      stdout: (text) => {
        out += text;
      },
      stderr: (text) => {
        err += text;
      },
      clock: () => CLOCK,
    });
    return { code, out, err };
  };

  it.each([
    ['число', '1'],
    ['год', '2026'],
    ['дата без дефисов', '20261115'],
    ['несуществующий день', '2026-02-30'],
    ['время без зоны', '2026-11-15T10:00:00'],
    ['свободный текст', 'Nov 15 2026'],
    ['дата в будущем', '9999-12-31'],
    ['больше суток вперёд', '2026-11-17T12:00:01Z'],
  ])('%s («%s») — отказ, код 2', async (_name, now) => {
    const result = await run(now);
    expect(result.code).toBe(2);
    expect(result.err).toContain('--now');
    expect(result.out).toBe('');
  });

  it.each([
    ['дата', '2026-11-15', '2026-11-15T00:00:00.000Z'],
    ['дата и время UTC', '2026-11-15T00:00:00Z', '2026-11-15T00:00:00.000Z'],
    ['со смещением зоны', '2026-11-15T03:00:00+03:00', '2026-11-15T00:00:00.000Z'],
    ['до суток вперёд', '2026-11-17T12:00:00Z', '2026-11-17T12:00:00.000Z'],
  ])('%s — принят, опорное время напечатано в отчёте', async (_name, now, printed) => {
    const result = await run(now);
    expect(result.err).toBe('');
    expect(result.out).toContain(`опорное время: ${printed}`);
  });
});

describe('Cli check: окружение', () => {
  it('YARN_* из окружения CLI — предупреждение в отчёте у проекта yarn 2+', async () => {
    const dir = TempDir.create();
    try {
      TempDir.copyFixture('yarn-berry-project/scripts', dir);
      TempDir.write(dir, {
        'deps-guard.json': JSON.stringify({
          disabled: { 'new-dependency': 'проверка окружения CLI, зависимости здесь не судятся' },
          sources: { registries: ['http://127.0.0.1:48721/'] },
        }),
      });
      let out = '';
      await Cli.main(['check', '--root', dir, '--now', '2026-11-15'], {
        cwd: dir,
        env: { YARN_ENABLE_SCRIPTS: '0' },
        stdout: (text) => {
          out += text;
        },
        stderr: () => undefined,
        clock: () => new Date('2026-11-16T12:00:00Z'),
      });
      expect(out).toContain('ПРЕДУПРЕЖДЕНИЕ: в окружении гейта заданы YARN_ENABLE_SCRIPTS');
    } finally {
      TempDir.remove(dir);
    }
  });
});

/**
 * `baseline --out` и `metadata --out` пишут файлы, которые потом читает
 * `check` от корня проекта, — относительный путь от `--root`. Абсолютный путь
 * прежде склеивался с корнем (`<root>/<абсолютный>`) и не записывался.
 */
describe('Cli baseline --out', () => {
  let dir: string;
  let elsewhere: string;

  beforeEach(() => {
    dir = GreenProject.create();
    elsewhere = TempDir.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
    TempDir.remove(elsewhere);
  });

  const io = (cwd: string) => ({
    cwd,
    env: {},
    stdout: () => undefined,
    stderr: () => undefined,
    clock: () => GreenProject.NOW,
  });

  it('абсолютный путь — как есть, а не под корнем', async () => {
    const target = join(elsewhere, 'base.json');
    expect(await Cli.main(['baseline', '--root', dir, '--out', target], io(elsewhere))).toBe(0);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ dependencies: expect.any(Array) });
  });

  it('относительный путь — от --root (его читает check), а не от рабочего каталога', async () => {
    expect(await Cli.main(['baseline', '--root', dir, '--out', 'base.json'], io(elsewhere))).toBe(0);
    expect(existsSync(join(dir, 'base.json'))).toBe(true);
    expect(existsSync(join(elsewhere, 'base.json'))).toBe(false);
  });
});
