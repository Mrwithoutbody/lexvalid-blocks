/**
 * Checklista formalna umowy — to, co prawnik robił z kartką i listą punktów.
 *
 * Pozycje są danymi w case-types/*.json, nie kodem: kancelaria dopisuje punkt
 * bez dotykania JS-a, a lista może różnić się między rodzajami spraw i stanami
 * prawnymi na dzień zawarcia umowy.
 *
 * Blok tylko porównuje — wspólnym językiem warunków (`src/conditions.mjs`).
 * Wartości bierze z faktów wyciągniętych z dokumentu (`facts`) i z przeliczeń
 * (`calculations`) — sam nic nie liczy i nie pyta modelu.
 */

import { under, valueAt } from "../../../src/contract/case-context.mjs";
import { holds, referencedPaths } from "../../../src/contract/conditions.mjs";
import { plural } from "../../../src/contract/plural.mjs";

// Operatory z warunku pozycji — podzbiór wspólnego języka, który ma tu sens.
// `<` zostaje za drzwiami, póki nie przyniesie go druga pozycja checklisty:
// każda para operatorów to jedna para więcej do pomylenia w edytorze.
const CHECKLIST_OPS = ["brak", "jest", ">", "rozjazd"];

export default {
  model: "analiza-dokumentu",
  name: "Checklista formalna",
  description: "Przechodzi listę obowiązkowych elementów umowy i zaznacza naruszenia.",

  // Lista z odhaczonymi pozycjami.
  icon: '<path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/>',

  // Czego blok potrzebuje, wprost z warunków: obie strony porównania sięgają
  // w kontekst sprawy, więc dopisanie pozycji na `calculations.rrso_gap` samo
  // domaga się przeliczeń wcześniej w pipeline.
  requires: (step) => referencedPaths((step.pozycje ?? []).map(({ gdy }) => gdy)),
  // Dowody czyta miękko: fakt policzony albo wpisany ręcznie cytatu nie ma
  // i to nie jest błąd ułożenia — pusty dowód mówi „zweryfikuj ręcznie".
  reads: (step) =>
    (step.pozycje ?? [])
      .map(({ gdy }) => gdy?.[0])
      .filter((path) => typeof path === "string" && path.startsWith("facts."))
      .map((path) => `evidence.${path.slice("facts.".length)}`),
  provides: ["checklist.findings", "checklist.checked", "checklist.critical"],
  report: true,

  /**
   * Czym konfiguruje się ten krok — tym samym słownikiem typów, co `form`.
   * `form` to pytanie do człowieka w trakcie sprawy, `settings` to pytanie do
   * tego, kto składa rodzaj sprawy z klocków. Czego blok tu nie wymieni,
   * edytor pokaże jako JSON i odda nietknięte.
   *
   * Operatory podaje blok, nie edytor: to `violated` wie, co umie porównać,
   * i nie ma drugiego miejsca, w którym ta lista mogłaby się rozjechać.
   */
  settings: [
    {
      id: "pozycje",
      label: "Pozycje checklisty",
      type: "wiersze",
      pola: [
        { id: "kod", label: "Kod", type: "tekst" },
        { id: "waga", label: "Waga", type: "wybor", opcje: ["krytyczny", "istotny"] },
        { id: "podstawa", label: "Podstawa prawna", type: "tekst" },
        { id: "opis", label: "Opis naruszenia", type: "tekst" },
        { id: "gdy", label: "Naruszona gdy", type: "warunek", operatory: CHECKLIST_OPS },
      ],
    },
  ],

  /**
   * Wkład do interfejsu: karty zarzutów (klik → szczegóły z podstawą,
   * orzecznictwem i cytatem) oraz zaznaczenia cytatów w materiale. Ranga 0 —
   * zarzut wygrywa nakładkę z faktem, bo po niego sięga się najczęściej.
   */
  widoki: (ctx) => {
    const { findings, checked } = ctx.checklist ?? {};
    if (findings == null) return [];

    if (!findings.length) {
      return [
        {
          widzet: "akapit",
          tekst: `Żadna z ${checked ?? 0} pozycji checklisty nie została naruszona.`,
        },
      ];
    }

    const ton = (waga) => (waga === "krytyczny" ? "blad" : "uwaga");

    return [
      {
        widzet: "karty",
        tytul: `Naruszenia (${findings.length}${checked ? ` z ${checked} sprawdzanych pozycji` : ""})`,
        karty: findings.map((f) => ({
          chip: `${f.kod} · ${f.waga ?? ""}`,
          ton: ton(f.waga),
          tekst: f.opis ?? "",
          szczegoly: [
            { etykieta: "Podstawa", tekst: f.podstawa ?? "—" },
            ...(f.orzeczenia ?? []).map((o) => ({
              etykieta: o.sygnatura ?? "",
              tekst: o.teza ?? "",
            })),
          ],
          cytat: f.dowod?.cytat ?? null,
          zaznaczenie: f.dowod?.cytat ? `mark-${f.kod}` : null,
        })),
      },
      {
        widzet: "zaznaczenia",
        zaznaczenia: findings
          .filter((f) => f.dowod?.cytat)
          .map((f) => ({
            cytat: f.dowod.cytat,
            rodzaj: ton(f.waga),
            ranga: 0,
            id: `mark-${f.kod}`,
            etykieta: `${f.kod} · ${f.opis}`,
            legenda: `zarzut ${f.waga}`,
          })),
      },
    ];
  },

  async run(ctx, step) {
    const items = step.pozycje ?? [];

    const findings = items
      .filter((item) => holds(item.gdy, ctx))
      .map(({ kod, waga, podstawa, opis, orzeczenia, gdy }) => ({
        kod,
        waga,
        podstawa,
        opis,
        // Dowód z ekstrakcji dla faktu z lewej strony warunku. Odczyt jest
        // miękki, nie w `requires`: fakt policzony albo wpisany ręcznie cytatu
        // nie ma i to nie jest błąd ułożenia — pusty dowód mówi „zweryfikuj
        // ręcznie", a przeliczenia niosą swój dowód w `metoda`/`zrodlo`.
        dowod: gdy?.[0]?.startsWith("facts.")
          ? (valueAt(`evidence.${gdy[0].slice("facts.".length)}`, ctx) ?? null)
          : null,
        // Orzecznictwo pod pozycją: sygnatura i teza jadą do raportu dla
        // prawnika; do pisma nie wchodzą, bo filtr `:zarzuty` bierze tylko
        // opis i podstawę.
        ...(orzeczenia?.length ? { orzeczenia } : {}),
      }));

    const critical = findings.filter((finding) => finding.waga === "krytyczny").length;

    const violations = plural(findings.length, "naruszenie", "naruszenia", "naruszeń");
    const suffix = critical ? `, w tym ${plural(critical, "krytyczne", "krytyczne", "krytycznych")}` : "";

    return {
      note: `${plural(items.length, "pozycja", "pozycje", "pozycji")} — ${violations}${suffix}`,
      values: under("checklist", { checked: items.length, findings, critical }),
    };
  },
};
