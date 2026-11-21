/** Значение разобранного подмножества YAML: скаляры — строки, кроме true/false/null. */
export type YamlValue = string | boolean | null | YamlValue[] | { [key: string]: YamlValue };
