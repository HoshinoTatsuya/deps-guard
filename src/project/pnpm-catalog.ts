import type { YamlObject } from '../types/yaml-object.type';

/**
 * Спецификатор `catalog:[имя]` → запись каталога (`catalog` — каталог по
 * умолчанию, `catalogs.<имя>`): pnpm — pnpm-workspace.yaml, yarn 4.10+ —
 * `.yarnrc.yml` (те же ключи). Протокол — без учёта регистра, как у
 * остальных протоколов.
 */
export class PnpmCatalog {
  /** `range: undefined` — записи нет; `undefined` — спецификатор не `catalog:`. */
  public static lookup(
    settings: YamlObject,
    name: string,
    specifier: string,
    file = 'pnpm-workspace.yaml',
  ): { range: string | undefined; label: string } | undefined {
    const match = /^catalog:(.*)$/i.exec(specifier.trim());
    if (!match) {
      return undefined;
    }
    const catalogName = (match[1] as string).trim() || 'default';
    const own = (value: unknown, key: string): unknown =>
      typeof value === 'object' && value !== null && !Array.isArray(value) && Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : undefined;
    const fromDefault = catalogName === 'default' ? own(settings.catalog, name) : undefined;
    const value = fromDefault ?? own(own(settings.catalogs, catalogName), name);
    const label = catalogName === 'default' ? 'catalog' : `catalogs.${catalogName}`;
    return typeof value === 'string'
      ? { range: value, label: `${label}: «${value}»` }
      : { range: undefined, label: `в ${file} нет ${label}.${name}` };
  }
}
