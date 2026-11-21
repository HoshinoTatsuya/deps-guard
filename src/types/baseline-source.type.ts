/**
 * База для «новых» зависимостей: git-ревизия (`origin/main`, merge-base MR)
 * или зафиксированный файл базовой линии (`deps-guard baseline`).
 */
export type BaselineSource = { readonly gitRef: string } | { readonly file: string };
