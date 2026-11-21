/** Значимая строка YAML: отступ, текст без отступа и хвостовых пробелов, номер (с 1). */
export interface YamlSourceLine {
  readonly indent: number;
  readonly text: string;
  readonly no: number;
}
