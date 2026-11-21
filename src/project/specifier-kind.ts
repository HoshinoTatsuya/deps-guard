import { PackageOrigin } from '../lockfile/package-origin';
import type { RangeKind } from '../types/range-kind.type';

/**
 * Вид спецификатора версии в package.json: `exact` — одна версия; плавающие —
 * {@link RangeKind}; `protocol` — не диапазон реестра по
 * {@link PackageOrigin.fromSpecifier} (`workspace:`, `file:`, git в любой
 * записи, включая `ssh://` и `git@хост:`, адрес, путь; источник судит правило
 * источников); `unknown` — не
 * разобран (запрещён всегда: неразобранное не считается точным). У `npm:` и
 * `jsr:` судится диапазон цели (`npm:foo@^1` — `caret`).
 */
export class SpecifierKind {
  public static of(specifier: string): RangeKind | 'exact' | 'protocol' | 'unknown' {
    const spec = specifier.trim();
    if (/^(?:npm|jsr):/i.test(spec)) {
      const range = PackageOrigin.rangeOf(spec);
      if (range === undefined || /^(?:npm|jsr):/i.test(range)) {
        return 'unknown';
      }
      return range === '' ? 'tag' : SpecifierKind.of(range);
    }
    // Не диапазон реестра — то же решение, что у источника: git, адрес, путь, протокол.
    if (PackageOrigin.fromSpecifier(spec).kind !== 'registry-default') {
      return 'protocol';
    }
    if (spec === '' || /^(?:\*|x|X)$/.test(spec)) {
      return 'any';
    }
    if (spec.includes('||') || / - /.test(spec) || /^(?:[<>]=?|=\s)/.test(spec) || /\s/.test(spec)) {
      return 'comparator';
    }
    if (spec.startsWith('^')) {
      return 'caret';
    }
    if (spec.startsWith('~')) {
      return 'tilde';
    }
    if (/^=?v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(spec)) {
      return 'exact';
    }
    if (/^=?v?\d+(?:\.(?:\d+|[xX*]))?(?:\.(?:\d+|[xX*]))?$/.test(spec)) {
      return 'x-range';
    }
    if (/^[A-Za-z][\w.-]*$/.test(spec)) {
      return 'tag';
    }
    return 'unknown';
  }
}
