import { MIN_REASON_LENGTH } from '../constants/min-reason-length.constant';

/**
 * Длина причины в видимых знаках: графемы (эмодзи, в том числе склеенные
 * ZWJ-последовательности вроде «семьи», и буква с ударением — один знак, а не
 * две-одиннадцать единиц UTF-16), и только те, в которых есть видимый символ
 * — буква, цифра, знак препинания или символ. Пробелы (в том числе в середине),
 * символы нулевой ширины, управляющие и пустые «заполнители», которые
 * выглядят пробелом, но числятся буквой или символом (U+115F, U+1160, U+3164,
 * U+FFA0 хангыля, U+2800 пустой брайль), не считаются: 30 таких знаков — пустая
 * причина, а не тридцать знаков.
 */
export class ReasonLength {
  private static readonly SEGMENTER = new Intl.Segmenter('ru', { granularity: 'grapheme' });

  private static readonly VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;

  private static readonly BLANK = /[ᅟᅠㅤﾠ⠀]/gu;

  public static of(reason: string): number {
    let count = 0;
    for (const { segment } of ReasonLength.SEGMENTER.segment(reason)) {
      if (ReasonLength.VISIBLE.test(segment.replace(ReasonLength.BLANK, ''))) {
        count += 1;
      }
    }
    return count;
  }

  /** Строка с причиной не короче {@link MIN_REASON_LENGTH} видимых знаков. */
  public static isEnough(reason: unknown): reason is string {
    return typeof reason === 'string' && ReasonLength.of(reason) >= MIN_REASON_LENGTH;
  }
}
