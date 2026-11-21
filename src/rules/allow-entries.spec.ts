import { MIN_REASON_LENGTH } from '../constants/min-reason-length.constant';
import { AllowEntries } from './allow-entries';
import { ReasonLength } from './reason-length';

const char = (code: number): string => String.fromCodePoint(code);

describe('AllowEntries', () => {
  it('граница длины причины: 30 знаков — допуск, 29 — нет; пробелы по краям не в счёт', () => {
    expect(MIN_REASON_LENGTH).toBe(30);
    const exact = 'а'.repeat(30);
    const short = 'а'.repeat(29);
    expect(AllowEntries.isAllowed({ x: exact }, 'x')).toBe(true);
    expect(AllowEntries.isAllowed({ x: short }, 'x')).toBe(false);
    expect(AllowEntries.isAllowed({ x: `   ${short}   ` }, 'x')).toBe(false);
    const audit = (reason: string): string[] =>
      AllowEntries.audit('source', 'sources', { x: reason }, 'deps-guard.json', () => true).map(
        (finding) => finding.verdict,
      );
    expect(audit(exact)).toEqual([]);
    expect(audit(short)).toEqual(['violation']);
    expect(audit(`   ${short}   `)).toEqual(['violation']);
  });

  it.each([
    ['15 эмодзи (30 единиц UTF-16)', char(0x1f512).repeat(15), 15],
    ['15 букв с комбинирующим ударением', `е${char(0x301)}`.repeat(15), 15],
    ['30 пробелов нулевой ширины', char(0x200b).repeat(30), 0],
    ['30 неразрывных пробелов', char(0xa0).repeat(30), 0],
    ['управляющие символы', `${char(1)}${'а'.repeat(29)}`, 29],
    [
      '10 эмодзи «семья» (ZWJ-последовательности) и 19 букв',
      `${[0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466].map(char).join('').repeat(10)}${'а'.repeat(19)}`,
      29,
    ],
    ['30 заполнителей хангыля U+3164', char(0x3164).repeat(30), 0],
    ['30 полуширинных заполнителей U+FFA0', char(0xffa0).repeat(30), 0],
    ['30 пустых знаков брайля U+2800', char(0x2800).repeat(30), 0],
    ['заполнители U+115F и U+1160', `${char(0x115f)}${char(0x1160)}`.repeat(15), 0],
    ['пробелы в середине', 'а '.repeat(29), 29],
    ['идеографический пробел U+3000', `${char(0x3000)}а`.repeat(29), 29],
    ['одни комбинирующие знаки', char(0x301).repeat(30), 0],
  ])('длина причины — видимые знаки: %s', (_name, reason, expected) => {
    expect(ReasonLength.of(reason)).toBe(expected);
    expect(AllowEntries.isAllowed({ x: reason }, 'x')).toBe(false);
  });

  it('видимые знаки разных классов засчитываются: буквы, цифры, знаки, эмодзи', () => {
    expect(ReasonLength.of(`а1.+${char(0x1f512)}`)).toBe(5);
    expect(AllowEntries.isAllowed({ x: `${'а'.repeat(25)}${char(0x2800)}1.+${char(0x1f512)}б` }, 'x')).toBe(
      true,
    );
  });

  it('предмет с именем свойства Object.prototype — не допуск и не падение', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(AllowEntries.isAllowed({}, name)).toBe(false);
    }
    expect(
      AllowEntries.isAllowed(
        JSON.parse('{"__proto__": "достаточно длинная причина допуска пакета"}'),
        '__proto__',
      ),
    ).toBe(true);
  });
});
