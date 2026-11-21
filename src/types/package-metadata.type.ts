/**
 * Метаданные пакета из реестра — подмножество документа реестра npm
 * (`GET <реестр>/<имя>`): `time` — даты публикации версий, `versions[v].hasInstallScript`
 * — есть ли install-скрипт (так его отдаёт сокращённый документ реестра).
 */
export interface PackageMetadata {
  readonly time?: Readonly<Record<string, string>>;
  readonly versions?: Readonly<Record<string, { readonly hasInstallScript?: boolean }>>;
}
