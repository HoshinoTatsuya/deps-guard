import { InputUnreadableError } from '../input-unreadable.error';
import type { Lockfile } from '../types/lockfile.type';
import type { RegistryDeclaration } from '../types/registry-declaration.type';
import { RcFile } from './rc-file';
import { YarnrcYml } from './yarnrc-yml';

/**
 * Реестры установки, заданные в проекте: `registry` и `@scope:registry` в
 * `.npmrc` (npm, pnpm, yarn 1) и в `.yarnrc` (yarn 1). Пакет без адреса в
 * lock-файле ставится именно отсюда, а не из `sources.defaultRegistry`.
 * Остальные строки этих файлов (токены) не разбираются. yarn 2+ `.npmrc` и
 * `.yarnrc` не читает: его реестры — `npmRegistryServer` и
 * `npmScopes.<scope>.npmRegistryServer` в `.yarnrc.yml`.
 */
export class ReadRegistrySettings {
  public static read(root: string, kind: Lockfile['kind']): RegistryDeclaration[] {
    if (kind === 'yarn-berry') {
      return ReadRegistrySettings.berry(root);
    }
    const wanted = (key: string): boolean => key === 'registry' || /^@[^:\s]+:registry$/.test(key);
    const files: Array<'.npmrc' | '.yarnrc'> = kind === 'yarn' ? ['.npmrc', '.yarnrc'] : ['.npmrc'];
    return files.flatMap((file) =>
      [...RcFile.read(root, file, wanted)].map(([key, { value, line }]) => ({
        key,
        scope: key === 'registry' ? undefined : key.slice(0, key.indexOf(':')),
        value,
        path: file,
        line,
      })),
    );
  }

  private static berry(root: string): RegistryDeclaration[] {
    const document = YarnrcYml.read(root);
    const settings = YarnrcYml.settings(document);
    const found: RegistryDeclaration[] = [];
    const take = (
      owner: Record<string, unknown>,
      key: string,
      label: string,
      scope: string | undefined,
    ): void => {
      if (!Object.hasOwn(owner, key)) {
        return;
      }
      const value = owner[key];
      const line = document?.lineOf(owner as never, key);
      if (typeof value !== 'string' || value.trim() === '') {
        throw new InputUnreadableError(YarnrcYml.FILE, `${label}: ожидался адрес реестра`, line);
      }
      found.push({ key: label, scope, value, path: YarnrcYml.FILE, line: line ?? 1 });
    };
    take(settings, 'npmRegistryServer', 'npmRegistryServer', undefined);
    const scopes = settings.npmScopes;
    if (scopes !== undefined && scopes !== null) {
      if (typeof scopes !== 'object' || Array.isArray(scopes)) {
        throw new InputUnreadableError(
          YarnrcYml.FILE,
          'npmScopes: ожидалось отображение',
          document?.lineOf(settings, 'npmScopes'),
        );
      }
      for (const [name, body] of Object.entries(scopes)) {
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new InputUnreadableError(
            YarnrcYml.FILE,
            `npmScopes.${name}: ожидалось отображение`,
            document?.lineOf(scopes, name),
          );
        }
        const scope = name.startsWith('@') ? name : `@${name}`;
        take(
          body as Record<string, unknown>,
          'npmRegistryServer',
          `npmScopes.${name}.npmRegistryServer`,
          scope,
        );
      }
    }
    return found;
  }
}
