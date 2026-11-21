import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/**
 * Одноразовый каталог спеки. Удаляется только каталог из `mkdtemp` с префиксом
 * спеки внутри системного tmp: ошибка в пути не уведёт `rm -r` никуда ещё.
 */
export class TempDir {
  public static readonly PREFIX = 'deps-guard-spec-';

  public static readonly FIXTURES = join(__dirname, '..', '..', 'fixtures');

  public static create(files: Readonly<Record<string, string>> = {}): string {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), TempDir.PREFIX));
    TempDir.write(dir, files);
    return dir;
  }

  public static write(dir: string, files: Readonly<Record<string, string>>): void {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
  }

  /** Скопировать фикстуру `fixtures/<имя>` в каталог (поверх). */
  public static copyFixture(name: string, dir: string): void {
    cpSync(join(TempDir.FIXTURES, name), dir, { recursive: true });
  }

  public static remove(dir: string): void {
    const root = realpathSync(tmpdir());
    if (dirname(dir) !== root || !basename(dir).startsWith(TempDir.PREFIX)) {
      throw new Error(`отказ удалять ${dir}: не каталог спеки`);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
