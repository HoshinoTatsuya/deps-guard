import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Cli } from '../cli/cli';
import { DepsGuard } from '../deps-guard';
import { GreenProject } from '../testing/green-project';
import { TempDir } from '../testing/temp-dir';
import type { CheckReport } from '../types/check-report.type';
import type { DepsGuardConfig } from '../types/deps-guard-config.type';

/**
 * Значение входа, у которого `String()` бросает: отображение YAML (у
 * разборщика оно без прототипа), объект JSON с собственным полем `toString`
 * (`{"toString": 1}` — не функция, `valueOf` возвращает объект), объект без
 * прототипа от вызывающего. Ветка, которая разбирает такой вход, обязана дать
 * понятный отказ с текстом, а не TypeError вместо него: `check` по контракту
 * не бросает на непрочитанном входе, а правило — не теряет свою находку.
 */
describe('RunCheck: «странное» значение входа — понятный отказ, а не TypeError', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      TempDir.remove(dir);
    }
  });

  const green = (): string => {
    const dir = GreenProject.create();
    dirs.push(dir);
    return dir;
  };

  const edit = (dir: string, file: string, change: (text: string) => string): void => {
    const path = join(dir, file);
    const before = readFileSync(path, 'utf8');
    const after = change(before);
    expect(after).not.toBe(before);
    writeFileSync(path, after);
  };

  const input = (report: CheckReport): string[] =>
    report.findings.filter((finding) => finding.rule === 'input').map((finding) => finding.reason);

  it('pnpm-lock.yaml: lockfileVersion — отображение', () => {
    const dir = green();
    edit(dir, 'pnpm-lock.yaml', (text) => text.replace("lockfileVersion: '9.0'", 'lockfileVersion:\n  a: b'));
    const report = DepsGuard.check({ root: dir, now: GreenProject.NOW });
    expect(input(report)).toEqual([
      'pnpm-lock.yaml:2: lockfileVersion «[object Object]» не поддерживается (поддержаны 6.x и 9.x)',
    ]);
  });

  it('pnpm-lock.yaml: resolution.type — отображение', () => {
    const dir = green();
    edit(dir, 'pnpm-lock.yaml', (text) =>
      text.replace(
        /(\n {2}'@pnpm\/exe\.android-arm64@12\.4\.1':\n) {4}resolution: \{[^\n]*\}/,
        '$1    resolution:\n      type:\n        a: b',
      ),
    );
    const report = DepsGuard.check({ root: dir, now: GreenProject.NOW });
    expect(report.findings.map((finding) => finding.reason).join('\n')).toContain('type: [object Object]');
    expect(report.findings.map((finding) => finding.reason).join('\n')).not.toContain('Cannot convert');
  });

  it('package-lock.json: lockfileVersion — объект с полем toString', () => {
    const dir = TempDir.create({
      'package.json': '{"name":"x"}',
      'package-lock.json': '{"lockfileVersion":{"toString":1},"packages":{}}',
      'deps-guard.json': '{}',
    });
    dirs.push(dir);
    const report = DepsGuard.check({ root: dir });
    expect(input(report)).toEqual([
      'package-lock.json: lockfileVersion [object Object] не поддерживается (поддержаны 2 и 3, npm 7+)',
    ]);
  });

  it('yarn.lock: __metadata.version — отображение', () => {
    const dir = TempDir.create();
    dirs.push(dir);
    TempDir.copyFixture(join('yarn-berry-project', 'formats', 'v10-yarn-4.18.1'), dir);
    TempDir.write(dir, { 'deps-guard.json': '{}' });
    edit(dir, 'yarn.lock', (text) =>
      text.replace('__metadata:\n  version: 10', '__metadata:\n  version:\n    a: b'),
    );
    const report = DepsGuard.check({ root: dir });
    expect(input(report)).toEqual([
      'yarn.lock:5: __metadata.version «[object Object]» не поддерживается (поддержаны 4, 5, 6, 7, 8, 9, 10)',
    ]);
  });

  it('deps-guard.json: bannedPackages[].name — объект с полем toString', () => {
    const dir = green();
    edit(dir, 'deps-guard.json', (text) => text.replace('"name": "request"', '"name": { "toString": 1 }'));
    const report = DepsGuard.check({ root: dir, now: GreenProject.NOW });
    expect(input(report)).toEqual([
      'deps-guard.json: bannedPackages[0].name: ожидалось имя пакета реестра (x или @scope/x, без версии), получено «[object Object]»',
    ]);
  });

  it('параметр config: bannedPackages[].name — объект без прототипа', () => {
    const dir = green();
    const config = {
      ...GreenProject.config(),
      bannedPackages: [{ name: Object.create(null), reason: GreenProject.REASON }],
    } as unknown as DepsGuardConfig;
    const report = DepsGuard.check({ root: dir, now: GreenProject.NOW, config });
    expect(input(report)).toEqual([
      'deps-guard.json: bannedPackages[0].name: ожидалось имя пакета реестра (x или @scope/x, без версии), получено «[object Object]»',
    ]);
  });

  it('package.json: значение зависимости — объект с полем toString', () => {
    const dir = green();
    edit(dir, 'package.json', (text) => {
      const json = JSON.parse(text) as { dependencies?: Record<string, unknown> };
      return JSON.stringify(
        { ...json, dependencies: { ...json.dependencies, weird: { toString: 1 } } },
        null,
        2,
      );
    });
    const report = DepsGuard.check({ root: dir, now: GreenProject.NOW });
    const reasons = report.findings.map((finding) => `${finding.rule}|${finding.subject}|${finding.reason}`);
    expect(reasons.join('\n')).not.toContain('Cannot convert');
    expect(reasons.filter((line) => line.includes('weird')).length).toBeGreaterThan(0);
  });

  it('параметр metadata: дата публикации — объект без прототипа', () => {
    const dir = green();
    const metadata = GreenProject.metadata(dir);
    const [name, entry] = Object.entries(metadata)[0] as [string, (typeof metadata)[string]];
    const version = Object.keys(entry.time ?? {})[0] as string;
    const report = DepsGuard.check({
      root: dir,
      now: GreenProject.NOW,
      metadata: { ...metadata, [name]: { ...entry, time: { [version]: Object.create(null) } } },
    });
    const freshness = report.findings.filter((finding) => finding.rule === 'freshness');
    expect(freshness.map((finding) => finding.verdict)).toEqual(['unverified']);
    expect(freshness[0]?.reason).toContain(`${name}@${version} (дата «[object Object]» не разобрана)`);
  });

  it('.yarnrc.yml: checksumBehavior — отображение — нарушение источника с текстом', () => {
    const dir = TempDir.create();
    dirs.push(dir);
    TempDir.copyFixture(join('yarn-berry-project', 'formats', 'v10-yarn-4.18.1'), dir);
    TempDir.write(dir, { 'deps-guard.json': '{}' });
    edit(dir, '.yarnrc.yml', (text) => `${text}checksumBehavior:\n  a: b\n`);
    const report = DepsGuard.check({ root: dir });
    const source = report.findings.filter(
      (finding) => finding.rule === 'source' && finding.subject === 'checksumBehavior',
    );
    expect(source.map((finding) => [finding.verdict, finding.reason])).toEqual([
      [
        'violation',
        'checksumBehavior: [object Object] — yarn не останавливает установку при несовпадении checksum (нужно throw или без ключа)',
      ],
    ]);
  });
});

describe('Cli.main: отказ со «странным» значением — код 2 и текст, а не TypeError', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      TempDir.remove(dir);
    }
  });

  it.each([
    ['null', (): unknown => null, 'null'],
    ['без прототипа', (): unknown => Object.create(null), '[object Object]'],
    [
      'с бросающим toString',
      (): unknown => ({
        toString: () => {
          throw new Error('toString');
        },
      }),
      '[object Object]',
    ],
  ])('вывод бросил значение %s', async (_label, make, text) => {
    const dir = GreenProject.create();
    dirs.push(dir);
    const errors: string[] = [];
    const code = await Cli.main(['check', '--now', GreenProject.NOW.toISOString()], {
      cwd: dir,
      env: {},
      stdout: () => {
        throw make();
      },
      stderr: (line) => errors.push(line),
      clock: () => GreenProject.NOW,
    });
    expect(code).toBe(2);
    expect(errors).toEqual([`deps-guard: ${text}\n`]);
  });
});
