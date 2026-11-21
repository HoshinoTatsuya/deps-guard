import { DEPENDENCY_FIELDS } from '../constants/dependency-fields.constant';
import { PackageOrigin } from '../lockfile/package-origin';
import type { DependencyField } from '../types/dependency-field.type';
import type { DirectDependency } from '../types/direct-dependency.type';
import type { Manifest } from '../types/manifest.type';
import { valueText } from '../value-text';

/** Прямые зависимости package.json по устанавливаемым полям; цель алиаса — {@link PackageOrigin}. */
export class DirectDependencies {
  public static of(
    manifest: Manifest,
    fields: readonly DependencyField[] = DEPENDENCY_FIELDS,
  ): DirectDependency[] {
    return fields.flatMap((field) => {
      const deps = manifest.json[field];
      if (typeof deps !== 'object' || deps === null) {
        return [];
      }
      return Object.entries(deps as Record<string, unknown>).map(([name, value]) => {
        const specifier = valueText(value);
        const line = manifest.lines.get(`${field}/${name}`);
        return {
          field,
          name,
          target: PackageOrigin.target(name, specifier).name,
          specifier,
          ...(line === undefined ? {} : { line }),
        };
      });
    });
  }
}
