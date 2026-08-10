// ponytail: pseudonimizacja regexowa — nietypowe nazwisko/adres przechodzi
// (uwaga o tym jedzie do raportu). Upgrade: lokalny NER, gdy wzorce
// przepuszczą coś na realnej umowie.
import { under } from "../../../src/contract/case-context.mjs";
import { PATTERNS, scan, splitNames } from "./patterns.mjs";

/**
 * Pseudonimizacja: identyfikatory i adresy schodzą pod etykiety, zanim tekst
 * trafi do modelu. To pseudonimizacja w rozumieniu art. 4 pkt 5 RODO, nie
 * anonimizacja — podmiana jest odwracalna i różnica jest prawna, nie stylistyczna.
 *
 * Podmiana i kontrola tego, co po niej zostało, stoją w jednym kroku. Wcześniej
 * były dwa klocki, a `pii-guard` wymagał `strony` i sam o nie nie pytał — więc
 * postawiony bez pseudonimizacji żądał danych, których nikt nie umiał dostarczyć.
 * Przede wszystkim jednak da się je było rozdzielić: pipeline z podmianą i bez
 * kontroli wyglądał na kompletny. Tego się nie pilnuje przeglądem, tylko tym,
 * że nie ma czego rozdzielić.
 *
 * Etykiety są numerowane i stałe w obrębie dokumentu: ten sam rachunek dostaje
 * wszędzie `[NR-RACHUNKU-1]`, więc model dalej widzi, że mowa o tym samym.
 *
 * Mapa podstawień zostaje w kontekście jednego przebiegu i nigdzie się nie
 * zapisuje — tak samo jak bajty umowy.
 *
 * Nazwisk nie da się złapać wzorcem, a modelu rozpoznawania nazw własnych Worker
 * nie uruchomi — biblioteki NER chcą node'a i kilkuset megabajtów wag. Więc blok
 * pyta o nie człowieka: kancelaria zna strony umowy, zanim otworzy dokument.
 * Podane nazwisko znika w każdej odmianie — Kowalski, Kowalskiego, Kowalskiemu.
 */

const WIELKIE = "A-ZĄĆĘŁŃÓŚŻŹ";
const MALE = "a-ząćęłńóśżź";

const ULICA = new RegExp(
  `(?:ul\\.|ulic[ay]|al\\.|alej[ai]|os\\.|osiedl[eu]|pl\\.|plac[u]?)\\s+[${WIELKIE}][^\\n,;()]{0,35}?\\d+[a-zA-Z]?(?:\\s*/\\s*\\d+[a-zA-Z]?|\\s+m\\.?\\s*\\d+)?`,
  "g",
);

const KOD_MIASTO = new RegExp(
  `\\d{2}-\\d{3}\\s+[${WIELKIE}][${MALE}${WIELKIE}-]+(?:\\s+[${WIELKIE}][${MALE}${WIELKIE}-]+){0,2}`,
  "g",
);

const escapeRe = (tekst) => tekst.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param names nazwiska stron podane przez kancelarię, np. ["Jan Kowalski"].
 *              Maskujemy całe imię i nazwisko oraz każdy człon z osobna, z końcówką
 *              fleksyjną do trzech znaków — inaczej „Kowalskiemu" przeszłoby obok.
 *              Wszystkie warianty jednej osoby dostają ten sam numer.
 * @returns { text, podstawienia, statystyka }
 */
export function pseudonymize(text, names = []) {
  const podstawienia = [];
  const liczniki = {};
  const znane = new Map();

  const etykieta = (typ, label, oryginal) => {
    const klucz = `${label}:${oryginal.toLowerCase()}`;

    if (!znane.has(klucz)) {
      liczniki[label] = (liczniki[label] ?? 0) + 1;
      znane.set(klucz, `[${label}-${liczniki[label]}]`);
    }

    const placeholder = znane.get(klucz);
    podstawienia.push({ placeholder, oryginal, typ });
    return placeholder;
  };

  for (const pattern of PATTERNS) {
    text = text.replace(pattern.re, (raw) =>
      pattern.ok && !pattern.ok(raw) ? raw : etykieta(pattern.type, pattern.label, raw),
    );
  }

  text = text.replace(ULICA, (raw) => etykieta("adres", "ADRES", raw));
  text = text.replace(KOD_MIASTO, (raw) => etykieta("adres", "ADRES", raw));

  for (const osoba of new Set(names)) {
    // Człony krótsze niż trzy znaki odpadają: inicjał „J." zamaskowałby pół umowy.
    const czlony = osoba.split(/\s+/).filter((czlon) => czlon.length >= 3);
    if (!czlony.length) continue;

    const klucz = `OSOBA:${osoba.toLowerCase()}`;
    if (!znane.has(klucz)) {
      liczniki.OSOBA = (liczniki.OSOBA ?? 0) + 1;
      znane.set(klucz, `[OSOBA-${liczniki.OSOBA}]`);
    }
    const placeholder = znane.get(klucz);

    const pelne = czlony.map((czlon) => `${escapeRe(czlon)}[${MALE}]{0,3}`).join("\\s+");
    const pojedyncze = czlony.map((czlon) => `\\b${escapeRe(czlon)}[${MALE}]{0,3}\\b`).join("|");

    text = text.replace(new RegExp(`${pelne}|${pojedyncze}`, "giu"), (raw) => {
      podstawienia.push({ placeholder, oryginal: raw, typ: "osoba" });
      return placeholder;
    });
  }

  const statystyka = {};
  for (const { typ } of podstawienia) statystyka[typ] = (statystyka[typ] ?? 0) + 1;

  return { text, podstawienia, statystyka };
}

/**
 * Co zostało po podmianie. Nazwisko podane przez kancelarię, które przetrwało,
 * znaczy że coś się rozjechało — i jest cięższym trafieniem niż wzorzec.
 */
export function leftovers(text, names) {
  const trafienia = scan(text);

  for (const osoba of names) {
    for (const czlon of osoba.split(/\s+/).filter((c) => c.length >= 3)) {
      if (new RegExp(`\\b${escapeRe(czlon)}`, "iu").test(text)) {
        trafienia.push({ typ: "nazwisko", fragment: `${czlon[0]}***` });
      }
    }
  }

  return trafienia;
}

export default {
  model: "analiza-dokumentu",
  // Podnieś, gdy zmienia się WYNIK tego klocka — sprawy policzone starszą
  // wersją same zgłoszą się do przeliczenia (`src/engine/versions.mjs`).
  wersja: 1,
  name: "Pseudonimizacja",
  description: "Zamienia identyfikatory i adresy na etykiety i sprawdza, co po nich zostało.",

  // Oko przekreślone.
  icon: '<path d="M10.73 5.08A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',

  requires: ["text.raw", "answers.strony"],
  // `podstawien` i `uwaga` stały w raporcie od początku, ale nie w deklaracji —
  // korzeń szedł do wyniku w całości, więc nikt tego nie zauważył.
  provides: [
    "text.safe",
    "pseudonymization.statystyka",
    "pseudonymization.trafienia",
    "pseudonymization.podstawien",
    "pseudonymization.uwaga",
  ],

  // Do raportu idzie sama statystyka i to, co zostało. `text.safe` NIE — to
  // treść umowy, a nie wynik analizy; wpisana do raportu wracałaby do
  // przeglądarki drugi raz, w polu przeznaczonym na wnioski.
  report: ["pseudonymization"],

  // Pole, w którym stoi nazwisko klienta — z niego bierze się kartoteka.
  // Deklaruje je blok, bo to on o nie pyta; silnik nie zna nazwy „strony"
  // i nie ma jej skąd znać.
  client: "strony",

  settings: [{ id: "blokuj", label: "Zatrzymaj sprawę, gdy coś zostało", type: "wybor", opcje: ["tak", "nie"] }],

  /**
   * Wkład do interfejsu — oba przy materiale, nie w wyniku: ostrzeżenie
   * o tym, co zostało po podmianie, i zaznaczenie każdej etykiety w miejscu,
   * z którego coś zdjęto. Ranga 2 — etykieta wewnątrz cytatu ustępuje
   * zarzutowi i faktowi, bo niesie tam mniej niż one.
   */
  widoki: (ctx) => {
    const out = [];
    const trafienia = ctx.pseudonymization?.trafienia ?? [];

    if (trafienia.length) {
      out.push({
        widzet: "akapit",
        slot: "material",
        ton: "uwaga",
        tekst: trafienia.map((t) => `${t.typ}: ${t.fragment}`).join("\n"),
      });
    }

    // Etykiety są numerowane w obrębie dokumentu, więc wzorzec, nie lista
    // typów — blok może dołożyć nowy typ bez zmiany widoku.
    const etykiety = ctx.text?.safe?.match(/\[[A-ZĄĆĘŁŃÓŚŻŹ]+(?:-[A-ZĄĆĘŁŃÓŚŻŹ]+)*-\d+\]/g) ?? [];

    if (etykiety.length) {
      out.push({
        widzet: "zaznaczenia",
        zaznaczenia: etykiety.map((etykieta, i) => ({
          cytat: etykieta,
          rodzaj: "maska",
          ranga: 2,
          id: `mark-pii-${i}`,
          etykieta: `zdjęte przed wysłaniem do modelu: ${etykieta}`,
          legenda: "dane zdjęte przed modelem",
        })),
      });
    }

    return out;
  },

  /**
   * Pytamy dopiero tutaj, a nie w kwalifikacji: człowiek ma przed sobą wgrany
   * dokument i przepisuje z niego strony, zamiast odtwarzać je z pamięci.
   */
  form: () => [
    {
      id: "strony",
      label: "Imiona i nazwiska stron umowy — po jednym w wierszu",
      type: "tekst",
    },
  ],

  async run(ctx, step) {
    const strony = splitNames(ctx.answers.strony);
    const { text, podstawienia, statystyka } = pseudonymize(ctx.text.raw, strony);
    const trafienia = leftovers(text, strony);

    const values = {
      "text.safe": text,
      // Sama statystyka do raportu — oryginały zostają w mapie, mapa w przebiegu.
      ...under("pseudonymization", {
        statystyka,
        podstawien: podstawienia.length,
        trafienia,
        // Ta uwaga jedzie do raportu celowo: bez niej „czysty" czyta się jak wyrok.
        uwaga: "Nazwisko, którego nikt nie wpisał, i nietypowy adres przejdą — czysty wynik to nie gwarancja.",
      }),
    };

    // `blokuj: "nie"` przepuszcza dalej ze śladem — do przebiegu na umowach
    // testowych, gdzie brak PII potwierdził człowiek. Domyślnie zatrzymujemy.
    if (trafienia.length && step.blokuj !== "nie") {
      const typy = [...new Set(trafienia.map((t) => t.typ))].join(", ");
      const pii = new Error(`w tekście zostały dane osobowe (${typy}) — nie wysyłam do modelu`);
      // Trafienia jadą do raportu, bo to one mówią, co zostało do sprawdzenia
      // ręcznie. `text.safe` też — pipeline i tak stanął, a następny krok
      // zażądałby go od nowa.
      pii.values = values;
      throw pii;
    }

    const opis = Object.entries(statystyka)
      .map(([typ, ile]) => `${typ}: ${ile}`)
      .join(", ");

    return {
      note: [
        podstawienia.length ? `${podstawienia.length} podstawień — ${opis}` : "nic do podmiany",
        trafienia.length ? `${trafienia.length} trafień po podmianie` : "wzorce czyste",
      ].join("; "),
      values,
    };
  },
};
