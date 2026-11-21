import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GreenProject } from '../testing/green-project';
import { TempDir } from '../testing/temp-dir';

jest.setTimeout(120_000);

const JEST = join(__dirname, '..', '..', 'node_modules', 'jest', 'bin', 'jest.js');
const GATE = join(__dirname, '..', '..', 'dist', 'jest', 'deps-guard-gate.js');

interface JestJson {
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: Array<{
    assertionResults: Array<{ title: string; status: string; failureMessages: string[] }>;
  }>;
}

/** Вложенный jest (один воркер) на спеке, которая вызывает собранный гейт. */
const runGate = (dir: string): Promise<JestJson> =>
  new Promise((resolve, reject) => {
    TempDir.write(dir, {
      'gate.spec.js': `const { depsGuardGate } = require(${JSON.stringify(GATE)});\ndepsGuardGate({ root: __dirname, now: new Date(${JSON.stringify(GreenProject.NOW.toISOString())}) });\n`,
    });
    execFile(
      process.execPath,
      [
        JEST,
        '--rootDir',
        dir,
        '--maxWorkers=1',
        '--ci',
        '--config',
        JSON.stringify({ testEnvironment: 'node', transform: {}, testMatch: ['**/gate.spec.js'] }),
        '--json',
        '--outputFile',
        join(dir, 'result.json'),
      ],
      { cwd: dir, timeout: 90_000 },
      (error) => {
        try {
          resolve(JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as JestJson);
        } catch {
          reject(error ?? new Error('вложенный jest не записал результат'));
        }
      },
    );
  });

describe('depsGuardGate', () => {
  let dir: string;

  beforeEach(() => {
    dir = GreenProject.create();
  });

  afterEach(() => {
    TempDir.remove(dir);
  });

  it('зелёный проект: тест на каждое правило, все прошли', async () => {
    const result = await runGate(dir);
    expect([result.numPassedTests, result.numFailedTests, result.numPendingTests]).toEqual([9, 0, 0]);
  });

  it('нарушение — красный тест своего правила с находкой в сообщении; отключённое — skip с причиной в имени', async () => {
    const config = GreenProject.config();
    TempDir.write(dir, {
      'deps-guard.json': JSON.stringify({
        ...config,
        floatingRanges: {},
        disabled: { typosquatting: 'свой список популярных пакетов ещё не собран' },
      }),
    });
    const result = await runGate(dir);
    expect([result.numPassedTests, result.numFailedTests, result.numPendingTests]).toEqual([7, 1, 1]);
    const assertions = result.testResults.flatMap((file) => file.assertionResults);
    const failed = assertions.filter((item) => item.status === 'failed');
    expect(failed.map((item) => item.title)).toEqual([expect.stringMatching(/^floating-range: /)]);
    expect(failed[0]?.failureMessages.join('\n')).toContain('semver');
    expect(assertions.filter((item) => item.status === 'pending').map((item) => item.title)).toEqual([
      'typosquatting [отключено: свой список популярных пакетов ещё не собран]',
    ]);
  });
});
