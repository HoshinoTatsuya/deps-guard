import type { YamlObject } from './yaml-object.type';

/** Каталоги версий менеджера: настройки с ключами `catalog`/`catalogs` и файл, где они записаны. */
export interface VersionCatalogs {
  readonly settings: YamlObject;
  readonly file: string;
}
