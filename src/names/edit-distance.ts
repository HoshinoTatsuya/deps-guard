/**
 * Расстояние Дамерау—Левенштейна в варианте OSA: вставка, удаление, замена и
 * перестановка соседних символов стоят 1 (`lodahs` → `lodash` — один шаг).
 * `limit` — ранний выход: результат больше `limit` возвращается как `limit + 1`.
 */
export class EditDistance {
  public static between(a: string, b: string, limit: number): number {
    if (Math.abs(a.length - b.length) > limit) {
      return limit + 1;
    }
    let previous2: number[] = [];
    let previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      const current: number[] = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let value = Math.min(
          (previous[j] as number) + 1,
          (current[j - 1] as number) + 1,
          (previous[j - 1] as number) + cost,
        );
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          value = Math.min(value, (previous2[j - 2] as number) + 1);
        }
        current.push(value);
        rowMin = Math.min(rowMin, value);
      }
      if (rowMin > limit) {
        return limit + 1;
      }
      previous2 = previous;
      previous = current;
    }
    return Math.min(previous[b.length] as number, limit + 1);
  }
}
