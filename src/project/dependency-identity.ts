import { posix } from 'node:path';

import { PackageOrigin } from '../lockfile/package-origin';
import type { YamlObject } from '../types/yaml-object.type';
import { PnpmCatalog } from './pnpm-catalog';

/**
 * Что за зависимость объявлена: пакет реестра — его настоящее имя (у
 * `npm:`-алиаса — имя цели); пакет не из реестра — имя и источник
 * `имя@источник` (git — адрес без коммита, архив — адрес, каталог и архив на
 * диске — путь от корня, ссылка — её цель). Ключ package.json, под которым
 * сменили источник (`aa-lib: ^1.0.0` → `aa-lib: https://…/bb-lib-1.0.0.tgz`,
 * → `aa-lib: git+https://…`), — другая зависимость: под старым именем ставится
 * чужой код. Смена коммита git той же зависимостью остаётся.
 * `workspace:` — проект этого же репозитория, по имени; `catalog:` — по записи
 * каталога pnpm-workspace.yaml.
 */
export class DependencyIdentity {
  public static of(name: string, specifier: string, importer: string, pnpmSettings: YamlObject): string {
    const catalog = PnpmCatalog.lookup(pnpmSettings, name, specifier);
    const spec = catalog?.range ?? specifier;
    const source = PackageOrigin.fromSpecifier(spec, importer);
    switch (source.kind) {
      case 'registry-default':
        return PackageOrigin.target(name, spec).name;
      case 'file':
      case 'directory': {
        const path = (source.url ?? '').replace(/^file:/i, '');
        return `${name}@file:${PackageOrigin.isAbsolute(path) ? path : posix.normalize(posix.join(importer, path))}`;
      }
      case 'link':
        return `${name}@link:${source.url ?? ''}`;
      case 'unknown':
        return /^workspace:/i.test(spec) ? name : `${name}@${spec.trim()}`;
      default:
        return `${name}@${source.url ?? spec.trim()}`;
    }
  }
}
