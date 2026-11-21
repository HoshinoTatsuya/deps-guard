import type { DependencyField } from './dependency-field.type';

/** Прямая зависимость из package.json. */
export interface DirectDependency {
  readonly field: DependencyField;
  /** Ключ в package.json (у `npm:`-алиаса — имя алиаса, под которым пакет лежит в node_modules). */
  readonly name: string;
  /** Настоящее имя пакета в реестре: у `npm:`-алиаса — имя цели. */
  readonly target: string;
  readonly specifier: string;
  readonly line?: number;
}
