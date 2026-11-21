import { execFileSync } from 'node:child_process';

/** git во временном каталоге спеки: свой автор, без системных настроек и подписи. */
export class GitRepo {
  public static run(dir: string, args: readonly string[]): string {
    return execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_AUTHOR_NAME: 'spec',
        GIT_AUTHOR_EMAIL: 'spec@example.invalid',
        GIT_COMMITTER_NAME: 'spec',
        GIT_COMMITTER_EMAIL: 'spec@example.invalid',
      },
    }).trim();
  }

  /** Закоммитить всё рабочее дерево; вернуть sha коммита. */
  public static commitAll(dir: string, message: string): string {
    GitRepo.run(dir, ['add', '-A']);
    GitRepo.run(dir, ['commit', '-q', '--no-gpg-sign', '-m', message]);
    return GitRepo.run(dir, ['rev-parse', 'HEAD']);
  }

  public static init(dir: string): void {
    GitRepo.run(dir, ['init', '-q', '-b', 'main']);
  }
}
