/** Строка документа YAML как есть (без перевода строки) и её номер (с 1). */
export interface YamlRawLine {
  readonly raw: string;
  readonly no: number;
}
