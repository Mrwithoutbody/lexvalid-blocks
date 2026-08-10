import { valueAt } from "../../../src/contract/case-context.mjs";
import { holds, OPERATORS, referencedPaths } from "../../../src/contract/conditions.mjs";
import { plural } from "../../../src/contract/plural.mjs";

/**
 * Pismo z szablonu — mechanizm w kodzie, treść w danych.
 *
 * Szablon stoi w definicji rodzaju sprawy (`szablon` w konfiguracji kroku),
 * a blok tylko podstawia wartości z kontekstu: `{facts.bank}`,
 * `{calculations.claim:zl}`, `{checklist.findings:zarzuty}`. Nowy rodzaj pisma
 * to nowy szablon w JSON-ie, nie nowy klocek — inaczej liczba wtyczek rosłaby
 * z liczbą pism, a rosnąć ma z liczbą rodzajów arytmetyki.
 *
 * `odmowa_gdy` to warunek, przy którym pisma NIE wolno złożyć — np. termin
 * zawity minął i pismo wprowadzałoby klienta w błąd co do uprawnienia, którego
 * już nie ma. Odmowa jest werdyktem (`rejections`), nie awarią.
 *
 * Czego blok nie wie, tego nie zmyśla: ścieżka bez wartości w kontekście
 * zostaje w piśmie jako [DO UZUPEŁNIENIA] — kancelaria wypełnia ją ręcznie,
 * bo analiza chodzi na dokumencie po pseudonimizacji i danych klienta nie zna.
 */

const PLACEHOLDER = /\{([a-z0-9_.]+)(?::([a-z_]+))?\}/g;

const MISSING = "[DO UZUPEŁNIENIA]";

/**
 * Tekst w nawiasach kwadratowych to notatka warsztatowa — `[DO WERYFIKACJI P]`
 * przy podstawie prawnej, `[może to być luka ekstrakcji]` w opisie zarzutu.
 * Pozycja checklisty pisze do dwóch czytelników naraz: do prawnika w raporcie
 * i — przez to pismo — do adresata. W piśmie notatka czytałaby się jak
 * przyznanie, że zarzut jest niepewny.
 */
const bezNotatek = (tekst) =>
  String(tekst ?? "")
    .replace(/\s*\[[^\]]*\]/g, "")
    .trim();

const FILTERS = {
  /** kwota po polsku: 13500 → „13500,00 zł" */
  zl: (value) => (typeof value === "number" ? `${value.toFixed(2).replace(".", ",")} zł` : null),
  /** lista zarzutów checklisty jako ponumerowane punkty, bez notatek warsztatowych */
  zarzuty: (findings) =>
    Array.isArray(findings) && findings.length
      ? findings
          .map((finding, i) => `${i + 1}. ${bezNotatek(finding.opis)} (${bezNotatek(finding.podstawa)})`)
          .join("\n")
      : null,
};

/**
 * Ścieżki, po które szablon sięga. Nieznany filtr wychodzi tutaj — czyli już
 * w `--check` i przy zapisie w edytorze, a nie na pierwszej sprawie.
 */
const placeholders = (step) =>
  [...String(step.szablon ?? "").matchAll(PLACEHOLDER)].map(([, path, filter]) => {
    if (filter && !FILTERS[filter]) {
      throw new Error(`nieznany filtr "${filter}" w szablonie (są: ${Object.keys(FILTERS).join(", ")})`);
    }
    return path;
  });

/** Szablon + kontekst sprawy → treść pisma. Eksport dla testów. */
export function fillTemplate(szablon, ctx) {
  return String(szablon).replace(PLACEHOLDER, (whole, path, filter) => {
    const value = valueAt(path, ctx);
    if (filter) return FILTERS[filter](value) ?? MISSING;

    // Bez filtra podstawiają się wyłącznie skalary. Obiekt wkleiłby się jako
    // bełkot, a pismo idzie do adresata — lepiej zostawić pole do uzupełnienia.
    return ["string", "number", "boolean"].includes(typeof value) && value !== ""
      ? String(value)
      : MISSING;
  });
}

export default {
  model: "analiza-dokumentu",
  // Podnieś, gdy zmienia się WYNIK tego klocka — sprawy policzone starszą
  // wersją same zgłoszą się do przeliczenia (`src/engine/versions.mjs`).
  wersja: 1,
  name: "Pismo z szablonu",
  description: "Składa pismo z szablonu i ustalonych faktów. Szablon jest danymi rodzaju sprawy, nie kodem.",

  // Koperta.
  icon: '<path d="M21.2 8.4c.5.38.8.97.8 1.6v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8c0-.63.3-1.22.8-1.6l8-6a2 2 0 0 1 2.4 0z"/><path d="m22 10-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 10"/>',

  // Wymagania wychodzą z danych: każda ścieżka w szablonie i w warunku odmowy
  // musi mieć dostawcę wcześniej w pipeline — literówka w `{facts.bnak}`
  // zatrzymuje `--check`, zamiast wyjść jako [DO UZUPEŁNIENIA] na sprawie.
  requires: (step) => [
    ...new Set([...placeholders(step), ...(step.odmowa_gdy ? referencedPaths([step.odmowa_gdy]) : [])]),
  ],
  provides: ["statement"],
  report: true,

  /** Wkład do interfejsu: zwijana treść pisma. */
  widoki: (ctx) =>
    ctx.statement ? [{ widzet: "tekst", tytul: "Szkic pisma", tekst: ctx.statement }] : [],

  settings: [
    { id: "odmowa_gdy", label: "Nie składaj pisma, gdy", type: "warunek", operatory: OPERATORS },
    { id: "odmowa_powod", label: "Powód odmowy", type: "tekst" },
    // `szablon` celowo poza listą: edytor pokaże go w JSON-ie kroku, a pole
    // jednowierszowe i tak nie uniosłoby całego pisma.
  ],

  async run(ctx, step) {
    if (!String(step.szablon ?? "").trim()) throw new Error("krok bez `szablon` — pismo nie ma treści");

    if (step.odmowa_gdy && holds(step.odmowa_gdy, ctx)) {
      const reason = step.odmowa_powod || "warunek odmowy pisma spełniony";
      const rejected = new Error(reason);
      rejected.rejections = [reason];
      throw rejected;
    }

    const statement = fillTemplate(step.szablon, ctx);
    const gaps = statement.split(MISSING).length - 1;

    return {
      note: gaps
        ? `pismo złożone, ${plural(gaps, "pole", "pola", "pól")} do uzupełnienia ręcznie`
        : "pismo złożone, komplet danych",
      values: { statement },
    };
  },
};
