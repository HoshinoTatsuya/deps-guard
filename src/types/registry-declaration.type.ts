/** Реестр установки из `.npmrc`/`.yarnrc` проекта. */
export interface RegistryDeclaration {
  /** `registry` или `@scope:registry`. */
  readonly key: string;
  /** `@scope` для реестра scope; `undefined` — реестр по умолчанию. */
  readonly scope: string | undefined;
  readonly value: string;
  readonly path: string;
  readonly line: number;
}
