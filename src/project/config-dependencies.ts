import { InputUnreadableError } from '../input-unreadable.error';
import type { YamlDocument } from '../types/yaml-document.type';
import { PnpmWorkspace } from './pnpm-workspace';

/**
 * Config-зависимости pnpm (`configDependencies` в pnpm-workspace.yaml): pnpm
 * ставит их и исполняет их код (pnpmfile, плагины) ДО установки, поэтому они
 * судятся как прямые зависимости. Значение — `версия+integrity`.
 */
export class ConfigDependencies {
  public static of(
    document: YamlDocument | undefined,
    label: string = PnpmWorkspace.FILE,
  ): Array<{ name: string; specifier: string; line?: number }> {
    const settings = PnpmWorkspace.settings(document);
    const section = settings.configDependencies;
    if (section === undefined || section === null) {
      return [];
    }
    if (
      typeof section !== 'object' ||
      Array.isArray(section) ||
      Object.values(section).some((value) => typeof value !== 'string')
    ) {
      throw new InputUnreadableError(
        label,
        'configDependencies: ожидалось отображение «имя: версия+integrity»',
        document?.lineOf(settings, 'configDependencies'),
      );
    }
    return Object.entries(section as Record<string, string>).map(([name, specifier]) => {
      const line = document?.lineOf(section, name);
      return { name, specifier, ...(line === undefined ? {} : { line }) };
    });
  }
}
