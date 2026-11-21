import { valueText } from './value-text';

describe('valueText: текст брошенного значения не бросает', () => {
  it('значение без прототипа — тег объекта', () => {
    expect(valueText(Object.create(null))).toBe('[object Object]');
  });

  it('бросающий toString — message, если это строка', () => {
    const value = {
      message: 'исходная причина',
      toString: () => {
        throw new Error('toString');
      },
    };
    expect(valueText(value)).toBe('исходная причина');
  });

  it('бросающий Symbol.toPrimitive — тег объекта', () => {
    const value = {
      [Symbol.toPrimitive]: () => {
        throw new Error('toPrimitive');
      },
    };
    expect(valueText(value)).toBe('[object Object]');
  });

  it('бросающий геттер message вместе с бросающим toString — запасной текст', () => {
    const value = Object.create(null, {
      message: {
        get: () => {
          throw new Error('message');
        },
      },
    });
    expect(valueText(value)).toBe('[значение без текста]');
  });

  it('обычная ошибка — «Имя: сообщение»', () => {
    expect(valueText(new TypeError('плохой аргумент'))).toBe('TypeError: плохой аргумент');
  });

  it('строка и undefined — как String()', () => {
    expect(valueText('текст')).toBe('текст');
    expect(valueText(undefined)).toBe('undefined');
  });
});
