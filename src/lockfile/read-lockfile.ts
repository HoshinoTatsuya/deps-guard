import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { InputUnreadableError } from '../input-unreadable.error';
import type { Lockfile } from '../types/lockfile.type';
import { ParseNpmLock } from './parse-npm-lock';
import { ParsePnpmLock } from './parse-pnpm-lock';
import { ParseYarnBerryLock } from './parse-yarn-berry-lock';
import { ParseYarnLock } from './parse-yarn-lock';

/**
 * Найти и разобрать lock-файл проекта. Без явного пути — ровно один из
 * известных: два (pnpm и npm рядом) — отказ, потому что неизвестно, каким
 * ставит CI, а проверка не того файла — зелёная галочка за непроверенным.
 */
export class ReadLockfile {
  public static readonly KNOWN = [
    'pnpm-lock.yaml',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
  ] as const;

  public static read(root: string, configured?: string): Lockfile {
    const path = configured ?? ReadLockfile.detect(root);
    let text: string;
    try {
      text = readFileSync(join(root, path), 'utf8');
    } catch (error) {
      throw new InputUnreadableError(path, `lock-файл не прочитан (${(error as Error).message})`);
    }
    return ReadLockfile.parse(path, text);
  }

  /** Разобрать текст lock-файла по имени файла (`.yaml` — pnpm, `.json` — npm, `.lock` — yarn). */
  public static parse(path: string, text: string): Lockfile {
    const name = basename(path);
    if (name.endsWith('.yaml') || name.endsWith('.yml')) {
      return ParsePnpmLock.parse(text, path);
    }
    if (name.endsWith('.json')) {
      return ParseNpmLock.parse(text, path);
    }
    if (name.endsWith('.lock')) {
      // Как решает сам yarn 2+: заголовок «# yarn lockfile v1» в начале (после комментариев) — yarn 1, иначе — YAML berry.
      return /^(?:#.*\r?\n)*?#\s+yarn\s+lockfile\s+v1\r?\n/i.test(text.replace(/^\uFEFF/, ''))
        ? ParseYarnLock.parse(text, path)
        : ParseYarnBerryLock.parse(text, path);
    }
    throw new InputUnreadableError(path, 'формат lock-файла не распознан по имени (.yaml, .json, .lock)');
  }

  private static detect(root: string): string {
    const found = ReadLockfile.KNOWN.filter((name) => existsSync(join(root, name)));
    if (found.length !== 1) {
      throw new InputUnreadableError(
        '.',
        found.length === 0
          ? `нет lock-файла (${ReadLockfile.KNOWN.join(', ')}): без него дерево зависимостей не проверить`
          : `несколько lock-файлов (${found.join(', ')}): укажите проверяемый ключом lockfile`,
      );
    }
    return found[0] as string;
  }
}
