import { EditDistance } from './edit-distance';

/**
 * Похоже ли имя на популярное, и чем: смешение `-`/`_`/`.` и регистра,
 * перестановка частей имени, подмена scope (`@types-x/node`, `@typess/node`),
 * малое расстояние правки. Порог расстояния растёт с длиной: у коротких имён
 * (`ms`, `qs`) соседей на расстоянии 1 десятки, и они законны.
 */
export class SimilarName {
  private readonly exact: ReadonlySet<string>;
  private readonly bySeparators = new Map<string, string[]>();
  private readonly byTokens = new Map<string, string[]>();
  private readonly scopesOfBare = new Map<string, string[]>();
  private readonly scopes = new Set<string>();

  public constructor(private readonly popular: readonly string[]) {
    this.exact = new Set(popular);
    for (const name of popular) {
      SimilarName.push(this.bySeparators, SimilarName.squash(name), name);
      const tokens = SimilarName.tokenKey(name);
      if (tokens !== undefined) {
        SimilarName.push(this.byTokens, tokens, name);
      }
      const scoped = SimilarName.splitScope(name);
      if (scoped) {
        SimilarName.push(this.scopesOfBare, scoped.bare, scoped.scope);
        this.scopes.add(scoped.scope);
      }
    }
  }

  /** Причины сходства; пусто — имя популярно само или ни на что не похоже. */
  public reasons(name: string): string[] {
    if (this.exact.has(name)) {
      return [];
    }
    // Scope в реестре npm принадлежит владельцу: в популярный scope публикует только он,
    // поэтому соседи внутри него (`@aws-sdk/client-sso` рядом с `client-s3`) — не подмена.
    const own = SimilarName.splitScope(name);
    if (own && this.scopes.has(own.scope)) {
      return [];
    }
    const reasons: string[] = [];
    for (const target of this.bySeparators.get(SimilarName.squash(name)) ?? []) {
      reasons.push(`смешение разделителей или регистра с «${target}»`);
    }
    const tokens = SimilarName.tokenKey(name);
    if (tokens !== undefined) {
      for (const target of this.byTokens.get(tokens) ?? []) {
        if (SimilarName.squash(target) !== SimilarName.squash(name)) {
          reasons.push(`перестановка частей имени «${target}»`);
        }
      }
    }
    const scoped = own;
    if (scoped) {
      for (const scope of this.scopes) {
        if (SimilarName.scopeLike(scoped.scope, scope)) {
          const sameBare = (this.scopesOfBare.get(scoped.bare) ?? []).includes(scope);
          reasons.push(
            sameBare ? `подмена scope: «@${scope}/${scoped.bare}»` : `scope похож на популярный «@${scope}»`,
          );
        }
      }
    }
    if (reasons.length === 0) {
      const limit = SimilarName.limit(name);
      for (const target of limit > 0 ? this.popular : []) {
        const distance = EditDistance.between(name, target, limit);
        if (distance > 0 && distance <= limit && SimilarName.limit(target) > 0) {
          reasons.push(`расстояние правки ${distance} до «${target}»`);
        }
      }
    }
    return reasons;
  }

  /** Порог расстояния по длине имени без scope: < 5 — 0, 5–9 — 1, от 10 — 2. */
  private static limit(name: string): number {
    const bare = SimilarName.splitScope(name)?.bare ?? name;
    return bare.length < 5 ? 0 : bare.length < 10 ? 1 : 2;
  }

  private static scopeLike(candidate: string, popular: string): boolean {
    if (candidate.length < 3) {
      return false;
    }
    return (
      EditDistance.between(candidate, popular, 1) <= 1 ||
      candidate.startsWith(`${popular}-`) ||
      candidate.startsWith(`${popular}_`) ||
      candidate.endsWith(`-${popular}`) ||
      SimilarName.squash(candidate) === SimilarName.squash(popular)
    );
  }

  private static squash(name: string): string {
    return name.toLowerCase().replace(/[-_.]/g, '');
  }

  /**
   * Ключ перестановки: scope как есть и отсортированные части имени без scope.
   * Scope в части не входит: `pg-types` — законный пакет, а не перестановка
   * `@types/pg` (замер на lock-файлах: единственное ложное срабатывание).
   */
  private static tokenKey(name: string): string | undefined {
    const scoped = SimilarName.splitScope(name);
    const tokens = (scoped?.bare ?? name)
      .toLowerCase()
      .split(/[-_.]/)
      .filter((token) => token !== '');
    return tokens.length >= 2 ? `${scoped?.scope ?? ''}|${[...tokens].sort().join(' ')}` : undefined;
  }

  private static splitScope(name: string): { scope: string; bare: string } | undefined {
    const match = /^@([^/]+)\/(.+)$/.exec(name);
    return match?.[1] !== undefined && match[2] !== undefined
      ? { scope: match[1], bare: match[2] }
      : undefined;
  }

  private static push(map: Map<string, string[]>, key: string, value: string): void {
    const list = map.get(key);
    if (list) {
      list.push(value);
    } else {
      map.set(key, [value]);
    }
  }
}
