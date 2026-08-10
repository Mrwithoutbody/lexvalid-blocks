/**
 * Przeliczenia: RRSO i limit kosztów pozaodsetkowych.
 *
 * Model językowy tu nie wchodzi. Te kwoty trafiają do pozwu i biegły je
 * przeliczy, więc muszą być policzone kodem, który da się pokryć testami.
 *
 * Stawki limitu są konfiguracją, nie stałą w kodzie — ustawodawca je zmieniał
 * i będzie zmieniał, a sprawa liczy się według stanu na dzień zawarcia umowy.
 */

// Model bywa, że zwraca datę po polsku mimo instrukcji — a blok terminu i ten
// muszą przeczytać tę samą datę tak samo, więc normalizacja jest wspólna.
import { under } from "../../../src/contract/case-context.mjs";
import { normalizeDate } from "../../../src/contract/dates.mjs";

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

const MAX_RATE = 10; // 1000% — wyżej nie sięga żadna umowa konsumencka

/**
 * RRSO z równania z załącznika do ustawy o kredycie konsumenckim: szukamy X,
 * przy którym wartość bieżąca rat równa się kwocie faktycznie wypłaconej.
 * Bisekcja, bo funkcja jest monotoniczna (wyższa stopa → niższa wartość
 * bieżąca) i nie potrzebujemy pochodnej.
 */
export function computeRrso({ payout, installment, installments, periodsPerYear = 12 }) {
  const presentValue = (rate) => {
    let sum = 0;
    for (let n = 1; n <= installments; n++) sum += installment / (1 + rate) ** (n / periodsPerYear);
    return sum;
  };

  // Poza tym przedziałem bisekcja zwróciłaby kraniec i wyglądałby jak wynik.
  // Ta liczba idzie do pozwu, więc lepiej powiedzieć, że dane się nie trzymają.
  if (presentValue(0) < payout) throw new Error("suma rat niższa niż wypłata — sprawdź kwoty");
  if (presentValue(MAX_RATE) > payout) throw new Error("RRSO ponad 1000% — sprawdź kwoty");

  let low = 0;
  let high = MAX_RATE;

  // 60 połowień wyczerpuje precyzję double na tym przedziale.
  for (let step = 0; step < 60; step++) {
    const middle = (low + high) / 2;
    if (presentValue(middle) > payout) low = middle;
    else high = middle;
  }

  return ((low + high) / 2) * 100;
}

/**
 * Okres spłaty w dniach — do części rocznej limitu z art. 36a UKK.
 *
 * Przepis mówi o okresie, na który udzielono kredytu, a nie o liczbie rat, więc
 * gdy dokument podaje datę całkowitej spłaty, liczymy z dat. Wcześniejsza spłata
 * skraca okres i obniża limit — czyli nadwyżka nad limitem może się pojawić tam,
 * gdzie z liczby rat jej nie widać. Ta kwota idzie do pozwu.
 *
 * Bez tej daty zostaje harmonogram planowy. `zrodlo` mówi, które z dwojga —
 * bo różnica między „umowa była na 4 lata" a „spłacił po 2" to inny limit.
 *
 * @returns { dni, zrodlo: "z dat" | "harmonogram planowy" }
 */
export function repaymentPeriod({ data_umowy, data_calkowitej_splaty, liczba_rat }, periodsPerYear) {
  const od = normalizeDate(data_umowy);
  const do_ = normalizeDate(data_calkowitej_splaty);

  if (od && do_) {
    const dni = Math.round((Date.parse(`${do_}T00:00:00Z`) - Date.parse(`${od}T00:00:00Z`)) / 86_400_000);
    // Data spłaty przed datą zawarcia to przekręcone dane, nie kredyt na minus dni.
    if (dni > 0) return { dni, zrodlo: "z dat" };
  }

  return { dni: Math.round((liczba_rat / periodsPerYear) * 365), zrodlo: "harmonogram planowy" };
}

/**
 * Maksymalne koszty pozaodsetkowe. Kształt wzoru z art. 36a UKK:
 * część stała od kwoty kredytu + część roczna proporcjonalna do okresu,
 * całość ograniczona pułapem procentowym.
 */
export function nonInterestLimit({ creditAmount, repaymentDays, rates }) {
  const { staly_procent, roczny_procent, maks_procent, dni_w_roku = 365 } = rates;

  const fixedPart = creditAmount * (staly_procent / 100);
  const yearlyPart = creditAmount * (roczny_procent / 100) * (repaymentDays / dni_w_roku);
  const ceiling = creditAmount * (maks_procent / 100);

  return Math.min(fixedPart + yearlyPart, ceiling);
}

/** Bez tych czterech liczb nie ma czego liczyć — reszta wzorów z nich wynika. */
const NEEDED_FIELDS = ["kwota_kredytu", "prowizja", "liczba_rat", "rata_miesieczna"];

/** Co blok kładzie do `ctx.calculations`. Checklista adresuje to po nazwie. */
const RESULTS = [
  "payout",
  "total_paid",
  // Całkowita kwota do zapłaty z art. 5 pkt 8 UKK — do zestawienia z tą, którą
  // umowa ma wydrukowaną. Gdy umowa podaje całkowity koszt, to jest suma kwoty
  // kredytu i tego kosztu (tożsamość z przepisu); rekonstrukcja z rat wchodzi
  // dopiero w braku — raty wyrównujące pierwszej i ostatniej raty potrafią
  // rozjechać rekonstrukcję o setki złotych i postawić zarzut umowie, której
  // liczby się zgadzają.
  "total_due",
  "total_cost",
  // Skąd wzięła się kwota kosztu: „z umowy" albo „rekonstrukcja z rat" —
  // ta sama różnica, co `repayment_source`: kwota idzie do pozwu i czytający
  // musi wiedzieć, czy stoi na dokumencie, czy na założeniu.
  "cost_source",
  "interest",
  "rrso_computed",
  "rrso_declared",
  "rrso_gap",
  "non_interest_costs",
  // Okres jedzie do wyniku razem z limitem, który z niego wychodzi: limit
  // policzony z harmonogramu planowego wygląda identycznie jak policzony
  // z faktycznych dat, a to jest różnica w kwocie idącej do pozwu.
  "repayment_days",
  "repayment_source",
  "non_interest_limit",
  "excess_over_limit",
  "claim",
];

export default {
  model: "analiza-dokumentu",
  // Podnieś, gdy zmienia się WYNIK tego klocka — sprawy policzone starszą
  // wersją same zgłoszą się do przeliczenia (`src/engine/versions.mjs`).
  wersja: 1,
  name: "Przeliczenia",
  description: "RRSO, limit kosztów pozaodsetkowych i wartość roszczenia — kodem, nie modelem.",

  // Kalkulator — jedyny blok, który liczy kodem, nie modelem.
  icon: '<rect width="16" height="20" x="4" y="2" rx="2"/><path d="M8 6h8"/><path d="M16 14v4"/><path d="M16 10h.01M12 10h.01M8 10h.01M12 14h.01M8 14h.01M12 18h.01M8 18h.01"/>',

  // Ekstrakcja musi mieć te pola na liście, inaczej pipeline stanie tutaj —
  // zamiast policzyć roszczenie z tego, czego akurat nie brakowało.
  //
  // Daty, kwota brutto i całkowity koszt są na liście, choć bez nich blok liczy
  // dalej: `null` z dokumentu to brak informacji, na który jest fallback, ale
  // pipeline, który o nie nie pyta, cicho rekonstruuje kwoty, które umowa
  // podaje wprost. Pierwsze jest wynikiem, drugie błędem ułożenia.
  // `rrso` na liście z tego samego powodu, co daty: bez niego blok liczy dalej,
  // ale pipeline, który o deklarowane RRSO nie pyta, cicho gubi zarzut rozjazdu.
  requires: [
    ...NEEDED_FIELDS,
    "rrso",
    "data_umowy",
    "data_calkowitej_splaty",
    "kwota_udzielona",
    "calkowity_koszt",
  ].map((f) => `facts.${f}`),
  // Dowody miękko: nadpisanie ostrożnego rachunku wymaga cytatu (`proven`),
  // ale pipeline bez ekstrakcji dowodów po prostu zostaje przy rekonstrukcji.
  reads: ["evidence.kwota_udzielona", "evidence.calkowity_koszt"],
  provides: RESULTS.map((key) => `calculations.${key}`),
  report: true,

  /** Wkład do interfejsu: zwijana tabela „skąd ta kwota". */
  widoki: (ctx) => {
    if (!ctx.calculations) return [];

    return [
      {
        widzet: "tabela",
        tytul: "Wyliczenia — skąd ta kwota",
        wiersze: RESULTS.map((key) => [key.replace(/_/g, " "), ctx.calculations[key] ?? null]),
      },
    ];
  },

  // Stawki limitu z art. 36a: ustawodawca je zmieniał, a sprawa liczy się według
  // stanu na dzień zawarcia umowy — więc wchodzą tu, nie do kodu.
  settings: [
    {
      id: "limit_pozaodsetkowy",
      label: "Limit kosztów pozaodsetkowych",
      type: "grupa",
      pola: [
        { id: "staly_procent", label: "Część stała (%)", type: "liczba" },
        { id: "roczny_procent", label: "Część roczna (%)", type: "liczba" },
        { id: "maks_procent", label: "Sufit (% kwoty kredytu)", type: "liczba" },
      ],
    },
  ],

  async run(ctx, step) {
    // Ekstrakcja oddaje `null`, gdy czegoś nie ma w umowie — pipeline to
    // przepuszcza, bo pole istnieje. Tu potrzebna liczba, nie sama obecność.
    const missing = NEEDED_FIELDS.filter((field) => typeof ctx.facts?.[field] !== "number");

    // Bez pełnych danych nie liczymy „w przybliżeniu" — mówimy, czego brakuje.
    if (missing.length) throw new Error(`brak faktów do przeliczenia: ${missing.join(", ")}`);

    const { kwota_kredytu, prowizja, liczba_rat, rata_miesieczna, rrso, kwota_udzielona, calkowity_koszt } =
      ctx.facts;
    const periodsPerYear = step.okresow_w_roku ?? 12;

    // Umowa parą kwot — „udzielona" brutto obok całkowitej kwoty kredytu —
    // mówi wprost, ile klient dostał: kwotę netto. Prowizja siedzi wtedy
    // w brutto i odjęta jeszcze raz robiła z RRSO 11% rzekome 13% — fałszywy
    // zarzut z art. 30 na umowie, której liczby się zgadzają. Heurystyka
    // z konfiguracji wchodzi dopiero, gdy umowa pary nie podaje.
    // Kwota „z umowy" musi mieć cytat z umowy. Model potrafi zsumować składniki
    // i oddać wynik tak samo pewnie jak przepisany — a `factsFrom` odrzuca cytaty
    // spoza tekstu, więc wyliczona kwota przychodzi bez dowodu. Bramka dotyczy
    // wyłącznie pól OPCJONALNYCH, które nadpisują ostrożny domyślny rachunek:
    // nadpisanie wymaga dowodu, fallback nie. Odczyt `evidence` jest miękki jak
    // w checkliście — pipeline bez ekstrakcji dowodów po prostu zostaje przy
    // rekonstrukcji.
    const proven = (field) => ctx.evidence?.[field] != null;

    const kredytowana = step.prowizja_kredytowana !== false;
    const paraBrutto =
      typeof kwota_udzielona === "number" && kwota_udzielona > kwota_kredytu && proven("kwota_udzielona");
    const payout = paraBrutto || !kredytowana ? kwota_kredytu : kwota_kredytu - prowizja;

    const computed = computeRrso({
      payout,
      installment: rata_miesieczna,
      installments: liczba_rat,
      periodsPerYear,
    });

    const totalPaid = rata_miesieczna * liczba_rat;

    // Ile klient odda w sumie. Najpierw to, co umowa podaje wprost: całkowita
    // kwota do zapłaty to z definicji (art. 5 pkt 8 UKK) suma kwoty kredytu
    // i całkowitego kosztu — tożsamość z przepisu, zero rekonstrukcji.
    // W braku kosztu w umowie zostaje suma rat: prowizja kredytowana siedzi
    // już w ratach, płacona z góry do rat nie wchodzi, więc dochodzi osobno.
    const statedCost = typeof calkowity_koszt === "number" && proven("calkowity_koszt");
    const totalDue = statedCost
      ? kwota_kredytu + calkowity_koszt
      : paraBrutto || kredytowana
        ? totalPaid
        : totalPaid + prowizja;

    // Koszt kredytu: ile oddał minus ile dostał do ręki — to jest kwota
    // roszczenia przy sankcji kredytu darmowego, w każdym wariancie prowizji.
    const totalCost = totalDue - payout;

    const okres = repaymentPeriod(ctx.facts, periodsPerYear);

    const limit = nonInterestLimit({
      creditAmount: kwota_kredytu,
      repaymentDays: okres.dni,
      rates: step.limit_pozaodsetkowy,
    });

    const calculations = {
      payout: round(payout),
      total_paid: round(totalPaid),
      total_due: round(totalDue),
      total_cost: round(totalCost),
      cost_source: statedCost ? "z umowy" : "rekonstrukcja z rat",
      interest: round(totalCost - prowizja),
      rrso_computed: round(computed),
      rrso_declared: rrso ?? null,
      rrso_gap: typeof rrso === "number" ? round(computed - rrso) : null,
      non_interest_costs: round(prowizja),
      repayment_days: okres.dni,
      repayment_source: okres.zrodlo,
      non_interest_limit: round(limit),
      excess_over_limit: round(Math.max(0, prowizja - limit)),
      // Przy sankcji kredytu darmowego klient zwraca kapitał bez kosztów.
      // Wersja pełnej spłaty — przy trwającej umowie potrzebna historia wpłat.
      claim: round(totalCost),
    };

    const gap = calculations.rrso_gap;
    const note =
      `RRSO ${calculations.rrso_computed}%` +
      (gap === null ? "" : ` vs ${rrso}% deklarowane (${gap > 0 ? "+" : ""}${gap} p.p.)`) +
      `, roszczenie ${calculations.claim} zł` +
      // Zastrzeżenia w śladzie, nie tylko w wyniku: kto czyta przebieg, ma
      // wiedzieć, co stoi na dokumencie, a co na rekonstrukcji, zanim zajrzy
      // do liczb.
      (statedCost ? "" : "; koszt rekonstruowany z rat — umowa nie podaje całkowitego kosztu") +
      (okres.zrodlo === "z dat"
        ? ""
        : `; limit z okresu planowego (${okres.dni} dni) — brak daty spłaty w dokumencie`);

    return { note, values: under("calculations", calculations) };
  },
};
