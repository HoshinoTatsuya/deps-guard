/** package.json проекта или пакета workspace. */
export interface Manifest {
  /** Каталог относительно корня (`.` — корень). */
  readonly importer: string;
  /** Путь к package.json относительно корня. */
  readonly path: string;
  readonly json: Readonly<Record<string, unknown>>;
  /** Строка ключа зависимости в файле: `поле/имя` → номер строки. */
  readonly lines: ReadonlyMap<string, number>;
}
