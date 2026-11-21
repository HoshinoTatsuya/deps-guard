import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LoadConfig } from './config/load-config';

const ROOT = join(__dirname, '..');
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** Блоки ```ts README: первая строка — `// examples/<файл>.ts`, остальное — дословный кусок этого файла. */
const blocks = (readme: string): Array<{ readonly label: string; readonly body: string }> =>
  [...read(readme).matchAll(/```ts\n([\s\S]*?)```/g)].map((match) => {
    const [label = '', ...rest] = (match[1] ?? '').split('\n');
    return { label, body: rest.join('\n').trim() };
  });

/**
 * Код README — файлы из examples/: TypeScript проверяет typecheck против
 * настоящего API, настройку `deps-guard.json` — разбор настройки пакета.
 * Блок, которого нет в примерах, мог бы разойтись с API незаметно.
 */
describe.each(['README.md', 'README.ru.md'])('%s цитирует examples/', (readme) => {
  const found = blocks(readme);

  it('блоков TypeScript не меньше числа файлов примеров (выборка не выродилась)', () => {
    const files = readdirSync(join(ROOT, 'examples')).filter((file) => file.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(found.length).toBeGreaterThanOrEqual(files.length);
  });

  it('каждый блок TypeScript назван файлом примера и дословно в нём есть', () => {
    const problems = found.flatMap(({ label, body }) => {
      const file = /^\/\/ (examples\/[a-z.-]+\.ts)$/.exec(label)?.[1];
      if (file === undefined || !existsSync(join(ROOT, file))) {
        return [`блок без файла примера: ${label}`];
      }
      return body !== '' && read(file).includes(body) ? [] : [`${file}: текст блока расходится с файлом`];
    });
    expect(problems).toEqual([]);
  });

  it('настройка из README — дословно examples/deps-guard.json', () => {
    expect(read(readme)).toContain(read('examples/deps-guard.json').trim());
  });
});

describe('examples/deps-guard.json', () => {
  it('настройка проходит разбор пакета целиком, без отброшенных ключей', () => {
    const config = JSON.parse(read('examples/deps-guard.json')) as unknown;
    expect(LoadConfig.validate(config)).toEqual(config);
  });
});
