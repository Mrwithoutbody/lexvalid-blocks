/**
 * Termin zawity uprawnienia z sankcji kredytu darmowego — liczony kodem, nigdy
 * pytany modelu.
 *
 * PODSTAWA: art. 45 ust. 5 UKK — uprawnienie z art. 45 ust. 1 wygasa z upływem
 * roku od dnia wykonania umowy.
 *
 * [DO WERYFIKACJI P] SPORNE, CO ZNACZY „DZIEŃ WYKONANIA UMOWY". Dwie linie:
 *   A) dzień całkowitej spłaty kredytu (umowa wykonana przez obie strony) — korzystna dla konsumenta,
 *   B) dzień wykonania zobowiązania przez kredytodawcę, czyli wypłaty — restrykcyjna.
 * Blok liczy OBIE i sporu nie rozstrzyga. Rozejście się wykładni to status
 * `sporny` i decyzja prawnika. Nie upraszczać do jednej daty bez opinii.
 *
 * Wariant A liczymy od faktycznej daty całkowitej spłaty, gdy dokument ją podaje
 * — zaświadczenie o spłacie, adnotacja o wcześniejszej spłacie. Sama umowa jej
 * nie zawiera, więc zwykle zostaje harmonogram planowy (data zawarcia + liczba
 * rat) i wtedy wynik niesie zastrzeżenie: wcześniejsza spłata przesuwa termin
 * wstecz, czyli uprawnienie mogło wygasnąć wcześniej, niż tu widać. Skąd wzięta
 * data, mówi `zrodlo_daty_splaty` — i nie wolno tego zgubić po drodze.
 */

import { under } from "../../../src/contract/case-context.mjs";
import { addMonths, normalizeDate, toUtc } from "../../../src/contract/dates.mjs";

const DOBA_MS = 86_400_000;

function wariant(od, dzisiaj) {
  const wygasa = od ? addMonths(od, 12) : null;
  const teraz = toUtc(dzisiaj);
  const koniec = wygasa ? toUtc(wygasa) : null;

  if (!koniec || !teraz) return { od, wygasa, dni_do_wygasniecia: null, minal: null };

  const dni = Math.round((koniec.getTime() - teraz.getTime()) / DOBA_MS);
  return { od, wygasa, dni_do_wygasniecia: dni, minal: dni < 0 };
}

/** @returns { status, splata, wyplata, zrodlo_daty_splaty, na_dzien, opis, podstawa } */
export function computeDeadline(facts, dzisiaj) {
  const dataZawarcia = normalizeDate(facts.data_umowy ?? null);
  const splataZDokumentu = normalizeDate(facts.data_calkowitej_splaty ?? null);
  const rat = typeof facts.liczba_rat === "number" ? facts.liczba_rat : null;

  const splataPlanowa = dataZawarcia && rat != null ? addMonths(dataZawarcia, rat) : null;
  const dataSplaty = splataZDokumentu ?? splataPlanowa;

  const zrodlo = splataZDokumentu
    ? "z dokumentu"
    : splataPlanowa
      ? "harmonogram planowy"
      : "brak danych";

  // Wypłatę przybliżamy datą zawarcia — umowy rzadko podają osobną datę uruchomienia.
  const splata = wariant(dataSplaty, dzisiaj);
  const wyplata = wariant(dataZawarcia, dzisiaj);

  const a = splata.minal;
  const b = wyplata.minal;

  let status;
  if (a == null && b == null) status = "nieznany";
  else if (a === false && b === false) status = "otwarty";
  else if (a === true && b === true) status = "wygasly";
  else if (b === false) status = "otwarty"; // B otwarte ⇒ A otwarte, bo A ≥ B
  else if (a === true) status = "wygasly"; // A minęło ⇒ B minęło, bo B ≤ A
  else status = "sporny";

  return {
    status,
    splata,
    wyplata,
    zrodlo_daty_splaty: zrodlo,
    na_dzien: dzisiaj,
    opis: opisz(status, splata, wyplata, zrodlo),
    podstawa: "art. 45 ust. 5 UKK [DO WERYFIKACJI P — sporna wykładnia „dnia wykonania umowy”]",
  };
}

function opisz(status, splata, wyplata, zrodlo) {
  const zastrzezenie =
    zrodlo === "harmonogram planowy"
      ? " Data spłaty odtworzona z harmonogramu — wcześniejsza spłata przesuwa termin wstecz, potwierdzić z klientem."
      : zrodlo === "brak danych"
        ? " Brak daty zawarcia albo liczby rat — uzupełnić przed oceną."
        : "";

  if (status === "otwarty") {
    return (
      `Uprawnienie otwarte w obu wykładniach. Wygasa najpóźniej ${splata.wygasa} ` +
      `(pozostało ${splata.dni_do_wygasniecia} dni).${zastrzezenie}`
    );
  }

  if (status === "sporny") {
    return (
      `Wykładnie się rozchodzą: licząc od wypłaty uprawnienie wygasło ${wyplata.wygasa ?? "?"}, ` +
      `licząc od całkowitej spłaty wygasa ${splata.wygasa ?? "?"}. Dopuszczalność roszczenia zależy ` +
      `od przyjętej linii orzeczniczej — wymaga oceny prawnika.${zastrzezenie}`
    );
  }

  if (status === "wygasly") {
    return (
      `Uprawnienie wygasło w obu wykładniach (najpóźniej ${splata.wygasa ?? wyplata.wygasa}). ` +
      `Roszczenie nie przysługuje; kwoty w raporcie są wyłącznie informacyjne.${zastrzezenie}`
    );
  }

  return `Nie da się ustalić terminu — brak daty zawarcia umowy.${zastrzezenie}`;
}

export default {
  model: "analiza-dokumentu",
  // Podnieś, gdy zmienia się WYNIK tego klocka — sprawy policzone starszą
  // wersją same zgłoszą się do przeliczenia (`src/engine/wersje.mjs`).
  wersja: 1,
  name: "Termin z art. 45 ust. 5",
  description: "Liczy, czy uprawnienie do sankcji jeszcze biegnie — w obu spornych wykładniach.",

  // Klepsydra.
  icon: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',

  // Data spłaty jest na liście, choć umowa rzadko ją zawiera: `null` z dokumentu
  // to brak informacji i blok ma na to fallback, ale pipeline, który o nią nie
  // pyta, cicho skazuje wariant A na harmonogram planowy. Pierwsze jest wynikiem,
  // drugie błędem ułożenia — i `--check` ma je rozróżniać.
  requires: ["facts.data_umowy", "facts.liczba_rat", "facts.data_calkowitej_splaty"],
  // `na_dzien` jedzie do wyniku razem ze statusem: „wygasły" bez dnia, na który
  // to policzono, jest nie do sprawdzenia — a policzone jest przy każdym żądaniu.
  provides: [
    "deadline.status",
    "deadline.opis",
    "deadline.podstawa",
    "deadline.wyplata",
    "deadline.splata",
    "deadline.zrodlo_daty_splaty",
    "deadline.na_dzien",
  ],
  report: true,

  /**
   * Wkład do interfejsu: chip statusu przy kwocie wyniku i akapit z pełnym
   * zdaniem. Słowa dziedziny („termin sporny — zależy od wykładni") stoją
   * tutaj, w klocku, który je policzył — host zna tylko widżety i tony.
   */
  widoki: (ctx) => {
    const { status, opis, podstawa } = ctx.deadline ?? {};
    if (!status) return [];

    const ETYKIETA = {
      otwarty: "Termin otwarty",
      sporny: "Termin sporny — zależy od wykładni",
      wygasly: "Termin upłynął — roszczenie nie przysługuje",
      nieznany: "Terminu nie ustalono",
    };
    const TON = { otwarty: "ok", sporny: "uwaga", wygasly: "blad", nieznany: "brak" };

    return [
      { widzet: "chip", etykieta: ETYKIETA[status] ?? status, ton: TON[status] ?? "brak" },
      { widzet: "akapit", tekst: opis, dopisek: podstawa },
    ];
  },

  async run(ctx, step) {
    // `na_dzien` w konfiguracji tylko po to, żeby test nie zależał od kalendarza.
    const dzisiaj = step.na_dzien ?? new Date().toISOString().slice(0, 10);

    const deadline = computeDeadline(ctx.facts, dzisiaj);

    return { note: `${deadline.status} — ${deadline.opis}`, values: under("deadline", deadline) };
  },
};
