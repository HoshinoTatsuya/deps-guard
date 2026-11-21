/** Ввод-вывод CLI (подменяется в тестах). */
export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Настоящее время (по умолчанию — часы процесса); для проверки `--now`. */
  clock?(): Date;
}
