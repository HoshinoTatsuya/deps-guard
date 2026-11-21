/** Локатор yarn berry `имя@протокол:ссылка[#селектор][::параметры]`. */
export interface BerryLocator {
  readonly name: string;
  /** Протокол без двоеточия, в нижнем регистре. */
  readonly protocol: string;
  readonly reference: string;
  /** Часть после `#` (у git — `commit=…`, у `file:`/`exec:` — путь). */
  readonly selector: string | undefined;
  /** Параметры после `::` (`locator=`, `hash=`, `version=`). */
  readonly params: URLSearchParams;
  /** Всё после `имя@`. */
  readonly raw: string;
}
