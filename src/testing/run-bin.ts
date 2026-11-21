import { execFile } from 'node:child_process';
import { join } from 'node:path';

/**
 * Запуск собранного bin пакета (`pnpm test` собирает dist до спек) в
 * каталоге проекта. Асинхронно: спека с поддельным реестром в том же
 * процессе иначе заблокировала бы его цикл событий. Свой потолок — зависший
 * CLI падает тестом, а не держит прогон.
 */
export class RunBin {
  public static readonly BIN = join(__dirname, '..', '..', 'bin', 'deps-guard.cjs');

  public static run(
    cwd: string,
    args: readonly string[],
    env: Readonly<Record<string, string>> = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [RunBin.BIN, ...args],
        { cwd, env: { ...process.env, ...env }, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          resolve({ code, stdout, stderr });
        },
      );
    });
  }
}
