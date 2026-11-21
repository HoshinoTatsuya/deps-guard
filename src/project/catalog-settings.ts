import type { Lockfile } from '../types/lockfile.type';
import type { VersionCatalogs } from '../types/version-catalogs.type';
import type { YamlDocument } from '../types/yaml-document.type';
import { PnpmWorkspace } from './pnpm-workspace';
import { YarnrcYml } from './yarnrc-yml';

/**
 * Каталоги версий (`catalog:`) менеджера проекта: pnpm — pnpm-workspace.yaml,
 * yarn 4.10+ — `.yarnrc.yml` (те же ключи `catalog` и `catalogs`); у npm и
 * yarn 1 каталогов нет.
 */
export class CatalogSettings {
  public static of(
    kind: Lockfile['kind'],
    pnpmWorkspace: YamlDocument | undefined,
    yarnrc: YamlDocument | undefined,
  ): VersionCatalogs {
    if (kind === 'yarn-berry') {
      return { settings: YarnrcYml.settings(yarnrc), file: YarnrcYml.FILE };
    }
    return {
      settings: kind === 'pnpm' ? PnpmWorkspace.settings(pnpmWorkspace) : Object.create(null),
      file: PnpmWorkspace.FILE,
    };
  }
}
