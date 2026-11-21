import { execFileSync } from 'node:child_process';

/**
 * Файл из git-ревизии. Ревизии нет — ошибка (база не прочитана, это не
 * «новых зависимостей нет»); файла в ревизии нет — `undefined` (проект
 * появился после базы, все его зависимости новые).
 */
export class GitShow {
  private static readonly TIMEOUT_MS = 30_000;

  public static reader(root: string): (ref: string, path: string) => string | undefined {
    const verified = new Set<string>();
    return (ref, path) => {
      if (!verified.has(ref)) {
        if (
          ref.startsWith('-') ||
          GitShow.git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) === undefined
        ) {
          throw new Error(
            `git-ревизия базы «${ref}» не найдена (в CI нужна глубина клона и fetch базовой ветки)`,
          );
        }
        verified.add(ref);
      }
      const spec = `${ref}:./${path}`;
      if (GitShow.git(root, ['cat-file', '-e', spec]) === undefined) {
        return undefined;
      }
      const text = GitShow.git(root, ['show', spec]);
      if (text === undefined) {
        throw new Error(`git show ${spec} не выполнен`);
      }
      return text;
    };
  }

  /** Файлы ревизии под каталогом проекта (пути — от корня проекта). Ревизии нет — ошибка. */
  public static lister(root: string): (ref: string) => string[] {
    return (ref) => {
      const text = ref.startsWith('-')
        ? undefined
        : GitShow.git(root, ['ls-tree', '-r', '--name-only', '-z', ref]);
      if (text === undefined) {
        throw new Error(`git ls-tree ${ref} не выполнен (в CI нужна глубина клона и fetch базовой ветки)`);
      }
      return text.split('\0').filter((file) => file !== '');
    };
  }

  private static git(root: string, args: string[]): string | undefined {
    try {
      return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: GitShow.TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      return undefined;
    }
  }
}
