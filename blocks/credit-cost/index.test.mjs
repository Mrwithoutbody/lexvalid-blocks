import { test } from "node:test";
import assert from "node:assert/strict";

import block, { computeRrso, nonInterestLimit, repaymentPeriod } from "./index.mjs";
import { runStep } from "../../../src/engine/index.mjs";

/**
 * Stawki WYMYŚLONE, okrągłe, do rachunku w pamięci. Nie są stawkami z art. 36a
 * i nie mają ich potwierdzać.
 *
 * Stawki z `case-types/*.json` wymagają potwierdzenia przez prawnika (patrz
 * README), więc test liczący na nich konkretne kwoty czytałby się jak ich
 * potwierdzenie, a potwierdzałby wyłącznie mnożenie.
 */
const RATES = { staly_procent: 20, roczny_procent: 10, maks_procent: 50 };

/** Wartość bieżąca rat przy danej stopie — do sprawdzenia wyniku bisekcji. */
const presentValue = (rate, installment, installments) => {
  let sum = 0;
  for (let n = 1; n <= installments; n++) sum += installment / (1 + rate) ** (n / 12);
  return sum;
};

// ── RRSO ─────────────────────────────────────────────────────────────────

test("bez kosztów RRSO wynosi zero", () => {
  const rrso = computeRrso({ payout: 1200, installment: 100, installments: 12 });
  assert.ok(Math.abs(rrso) < 0.01, `oczekiwano ~0, jest ${rrso}`);
});

test("wynik faktycznie zeruje równanie z załącznika", () => {
  const payout = 36900;
  const rrso = computeRrso({ payout, installment: 1050, installments: 48 });

  // Podstawiamy wynik z powrotem: wartość bieżąca rat musi wrócić do wypłaty.
  const check = presentValue(rrso / 100, 1050, 48);
  assert.ok(Math.abs(check - payout) < 0.01, `${check} ≠ ${payout}`);
});

test("suma rat niższa niż wypłata nie udaje ujemnego RRSO", () => {
  assert.throws(
    () => computeRrso({ payout: 1200, installment: 90, installments: 12 }),
    /suma rat niższa niż wypłata/,
  );
});

test("koszt ponad kraniec przedziału zatrzymuje blok, nie zwraca 1000%", () => {
  assert.throws(
    () => computeRrso({ payout: 1000, installment: 5000, installments: 12 }),
    /RRSO ponad 1000%/,
  );
});

test("wyższy koszt przy tej samej wypłacie daje wyższe RRSO", () => {
  const cheaper = computeRrso({ payout: 36900, installment: 1000, installments: 48 });
  const pricier = computeRrso({ payout: 36900, installment: 1100, installments: 48 });
  assert.ok(pricier > cheaper);
});

test("krótszy okres przy tym samym koszcie daje wyższe RRSO", () => {
  const long = computeRrso({ payout: 10000, installment: 12000 / 24, installments: 24 });
  const short = computeRrso({ payout: 10000, installment: 12000 / 12, installments: 12 });
  assert.ok(short > long);
});

// ── limit kosztów pozaodsetkowych ────────────────────────────────────────

test("limit to część stała plus część roczna", () => {
  // 20% z 1000 + 10% z 1000 za pół roku = 200 + 50 = 250, pułap 500 nie tnie.
  const limit = nonInterestLimit({ creditAmount: 1000, repaymentDays: 182.5, rates: RATES });
  assert.equal(limit, 250);
});

test("pułap procentowy ucina wynik przy długim okresie", () => {
  // 200 + 100·4 = 600, ale pułap to 50% z 1000.
  const limit = nonInterestLimit({ creditAmount: 1000, repaymentDays: 1460, rates: RATES });
  assert.equal(limit, 500);
});

test("stawki są konfiguracją, nie stałą w kodzie", () => {
  const wyzsze = nonInterestLimit({ creditAmount: 1000, repaymentDays: 365, rates: RATES });
  const nizsze = nonInterestLimit({
    creditAmount: 1000,
    repaymentDays: 365,
    rates: { staly_procent: 5, roczny_procent: 5, maks_procent: 50 },
  });

  assert.equal(wyzsze, 300); // 200 + 100
  assert.equal(nizsze, 100); // 50 + 50
});

// ── okres spłaty ─────────────────────────────────────────────────────────

test("data spłaty z dokumentu bije harmonogram planowy", () => {
  // Sama arytmetyka: 48 rat po 12 w roku to 1460 dni, a między 1.01.2020
  // a 1.01.2022 jest 731 dni (2020 przestępny). Czy tak liczy się okres
  // z art. 36a — [DO WERYFIKACJI P].
  const planowy = repaymentPeriod({ data_umowy: "2020-01-01", liczba_rat: 48 }, 12);
  assert.deepEqual(planowy, { dni: 1460, zrodlo: "harmonogram planowy" });

  const zDat = repaymentPeriod(
    { data_umowy: "2020-01-01", data_calkowitej_splaty: "2022-01-01", liczba_rat: 48 },
    12,
  );
  assert.deepEqual(zDat, { dni: 731, zrodlo: "z dat" });
});

test("data spłaty przed zawarciem to przekręcone dane, nie ujemny okres", () => {
  const okres = repaymentPeriod(
    { data_umowy: "2022-01-01", data_calkowitej_splaty: "2020-01-01", liczba_rat: 48 },
    12,
  );

  assert.equal(okres.zrodlo, "harmonogram planowy", "wracamy do planowego zamiast liczyć wstecz");
  assert.ok(okres.dni > 0);
});

test("data po polsku z modelu nie kasuje okresu z dat", () => {
  const okres = repaymentPeriod(
    { data_umowy: "01.01.2020", data_calkowitej_splaty: "01.01.2022", liczba_rat: 48 },
    12,
  );

  assert.deepEqual(okres, { dni: 731, zrodlo: "z dat" });
});

// ── blok w całości ───────────────────────────────────────────────────────

const FIELDS = {
  kwota_kredytu: 42000,
  prowizja: 5100,
  liczba_rat: 48,
  rata_miesieczna: 1050,
  rrso: 12.3,
  data_umowy: "2020-01-01",
  data_calkowitej_splaty: null,
};

const CONFIG = { limit_pozaodsetkowy: RATES };

test("blok liczy komplet i wykrywa rozbieżność RRSO", async () => {
  const ctx = { facts: FIELDS };
  const { note } = await runStep(block, ctx, CONFIG);
  const result = ctx.calculations;

  assert.equal(result.payout, 36900); // prowizja kredytowana nie trafia do klienta
  assert.equal(result.total_paid, 50400);
  assert.equal(result.total_cost, 13500);
  assert.equal(result.interest, 8400);
  assert.equal(result.claim, 13500);

  assert.ok(result.rrso_computed > 12.3, "przeliczone RRSO musi przebić deklarowane");
  // Rozbieżność jest zaokrąglona do groszy, więc porównujemy z tolerancją.
  assert.ok(Math.abs(result.rrso_gap - (result.rrso_computed - 12.3)) < 0.01);
  assert.match(note, /RRSO .* vs 12\.3% deklarowane/);
});

test("prowizja płacona z góry zmienia wypłatę, ale nie znika z roszczenia", async () => {
  const ctx = { facts: FIELDS };
  await runStep(block, ctx, { ...CONFIG, prowizja_kredytowana: false });

  assert.equal(ctx.calculations.payout, 42000); // klient dostał całą kwotę do ręki
  // Prowizję i tak zapłacił, więc koszt i roszczenie są takie same jak przy
  // prowizji kredytowanej — różni je wyłącznie RRSO, liczone od wypłaty.
  assert.equal(ctx.calculations.total_cost, 13500);
  assert.equal(ctx.calculations.interest, 8400);
  assert.equal(ctx.calculations.claim, 13500);
});

test("para kwot netto/brutto: klient dostał kwotę netto, nie netto minus prowizję", async () => {
  // Umowa podaje obie kwoty wprost — zgadywanie heurystyką byłoby nadpisaniem
  // umowy założeniem. Odjęcie prowizji drugi raz zawyżało RRSO o ~2 p.p.
  // i stawiało fałszywy zarzut z art. 30 ust. 1 pkt 7.
  const bez = { facts: FIELDS };
  await runStep(block, bez, CONFIG);

  const para = {
    facts: { ...FIELDS, kwota_udzielona: 47100 },
    evidence: { kwota_udzielona: { cytat: "kwota pozyczki brutto: 47 100 zl", strona: 1 } },
  };
  await runStep(block, para, CONFIG);

  assert.equal(para.calculations.payout, 42000);
  assert.ok(para.calculations.rrso_computed < bez.calculations.rrso_computed);
  // Prowizja siedzi w brutto, więc raty pokrywają wszystko: koszt = raty − netto.
  assert.equal(para.calculations.total_due, 50400);
  assert.equal(para.calculations.total_cost, 8400);
});

test("całkowity koszt z umowy bije rekonstrukcję z rat — i mówi, skąd jest", async () => {
  const zUmowy = {
    facts: { ...FIELDS, calkowity_koszt: 8400 },
    evidence: { calkowity_koszt: { cytat: "calkowity koszt: 8 400 zl", strona: 1 } },
  };
  await runStep(block, zUmowy, CONFIG);

  // Tożsamość z art. 5 pkt 8: kwota do zapłaty = kwota kredytu + koszt.
  assert.equal(zUmowy.calculations.total_due, 50400);
  assert.equal(zUmowy.calculations.cost_source, "z umowy");

  const rekonstrukcja = { facts: FIELDS };
  const { note } = await runStep(block, rekonstrukcja, CONFIG);

  assert.equal(rekonstrukcja.calculations.cost_source, "rekonstrukcja z rat");
  // Kwota idzie do pozwu — czytający ślad ma wiedzieć, że stoi na założeniu.
  assert.match(note, /koszt rekonstruowany z rat/);
});

test("kwota bez cytatu nie nadpisuje rachunku — model umie zsumować i oddać jako odczyt", async () => {
  // Prawdziwy przypadek z umowy PKO: model dodał prowizję do całkowitego kosztu
  // i oddał 61 463,67 tak samo pewnie jak przepisane 55 227,62. `factsFrom`
  // odrzucił zmyślony cytat, więc wartość przyszła bez dowodu — a bez dowodu
  // „z umowy" jest tylko etykietą, nie faktem.
  const bezDowodu = {
    facts: { ...FIELDS, calkowity_koszt: 8400, kwota_udzielona: 47100 },
    evidence: { calkowity_koszt: null, kwota_udzielona: null },
  };
  await runStep(block, bezDowodu, CONFIG);

  assert.equal(bezDowodu.calculations.cost_source, "rekonstrukcja z rat");
  assert.equal(bezDowodu.calculations.payout, 36900, "bez dowodu brutto wraca heurystyka z konfiguracji");
});

test("umowa z ratami wyrównującymi nie dostaje zarzutu od własnej arytmetyki", async () => {
  // Liczby z goldenu v1 (umowa-3-pko): pierwsza i ostatnia rata inne niż
  // pozostałe, więc rekonstrukcja `rata × liczba_rat` rozjeżdża się o setki
  // złotych. Kwoty zapisane w umowie są wewnętrznie spójne — i to je porównuje
  // R-004, a RRSO liczy się od tego, co klient faktycznie dostał.
  const ctx = {
    facts: {
      kwota_kredytu: 113000,
      kwota_udzielona: 119236.05,
      prowizja: 6236.05,
      calkowity_koszt: 55227.62,
      liczba_rat: 96,
      rata_miesieczna: 1746.82,
      rrso: 11.03,
      data_umowy: "2024-01-22",
      data_calkowitej_splaty: null,
    },
    evidence: {
      kwota_udzielona: { cytat: "Udzielamy Ci pozyczki w kwocie 119 236,05 zl", strona: 1 },
      calkowity_koszt: { cytat: "Calkowity koszt pozyczki wynosi 55 227,62 zl.", strona: 1 },
    },
  };
  await runStep(block, ctx, CONFIG);

  assert.equal(ctx.calculations.payout, 113000);
  assert.equal(ctx.calculations.total_due, 168227.62); // 113000 + 55227.62, co do grosza
  assert.equal(ctx.calculations.claim, 55227.62); // roszczenie = koszt z umowy, jak w goldenie v1
  assert.ok(Math.abs(ctx.calculations.rrso_gap) < 1, `RRSO gap ${ctx.calculations.rrso_gap} — ma nie stawiać R-001`);
});

test("całkowita kwota do zapłaty nie liczy kredytowanej prowizji dwa razy", async () => {
  // To jest liczba, z którą checklista zestawia tę wpisaną w umowę. Prowizja
  // kredytowana siedzi już w ratach — doliczona drugi raz robiłaby zarzut
  // z art. 30 ust. 1 pkt 7 umowie, której liczby się zgadzają.
  const kredytowana = { facts: FIELDS };
  await runStep(block, kredytowana, CONFIG);
  assert.equal(kredytowana.calculations.total_due, 50400); // same raty

  // Płacona z góry do rat nie wchodzi, więc do tej kwoty dochodzi.
  const zGory = { facts: FIELDS };
  await runStep(block, zGory, { ...CONFIG, prowizja_kredytowana: false });
  assert.equal(zGory.calculations.total_due, 55500);

  // W obu wariantach klient oddaje o tyle więcej, niż dostał, ile wynosi koszt.
  for (const ctx of [kredytowana, zGory]) {
    assert.equal(ctx.calculations.total_due - ctx.calculations.payout, ctx.calculations.total_cost);
  }
});

test("nadwyżka wychodzi dopiero wtedy, gdy koszt przebije limit", async () => {
  // Bez kwot wpisanych z ręki: porównujemy z limitem, który blok sam policzył.
  // Zapisana liczba udawałaby, że wiadomo, ile limit wynosi naprawdę.
  const tanio = { facts: FIELDS };
  await runStep(block, tanio, CONFIG);

  assert.ok(tanio.calculations.non_interest_costs < tanio.calculations.non_interest_limit);
  assert.equal(tanio.calculations.excess_over_limit, 0);

  const drogo = { facts: { ...FIELDS, prowizja: 25000 } };
  await runStep(block, drogo, CONFIG);

  assert.ok(drogo.calculations.non_interest_costs > drogo.calculations.non_interest_limit);
  assert.equal(
    drogo.calculations.excess_over_limit,
    drogo.calculations.non_interest_costs - drogo.calculations.non_interest_limit,
  );
});

test("krótszy okres spłaty to niższy limit i większa nadwyżka", async () => {
  const planowy = { facts: { ...FIELDS, prowizja: 20000 } };
  await runStep(block, planowy, CONFIG);
  assert.equal(planowy.calculations.repayment_source, "harmonogram planowy");

  // Ta sama umowa z datą spłaty w dokumencie. Kierunek, nie kwota: że skrócenie
  // okresu w ogóle przechodzi do wyniku — bo z liczby rat go nie widać.
  const wczesniej = { facts: { ...planowy.facts, data_calkowitej_splaty: "2020-07-01" } };
  const { note } = await runStep(block, wczesniej, CONFIG);

  assert.equal(wczesniej.calculations.repayment_source, "z dat");
  assert.ok(wczesniej.calculations.repayment_days < planowy.calculations.repayment_days);
  assert.ok(wczesniej.calculations.non_interest_limit < planowy.calculations.non_interest_limit);
  assert.ok(wczesniej.calculations.excess_over_limit > planowy.calculations.excess_over_limit);
  assert.doesNotMatch(note, /okresu planowego/, "przy danych z dokumentu nie ma czego zastrzegać");
});

test("limit z okresu planowego mówi o tym w śladzie", async () => {
  const { note } = await runStep(block, { facts: FIELDS }, CONFIG);

  assert.match(note, /limit z okresu planowego \(1460 dni\) — brak daty spłaty w dokumencie/);
});

test("brak faktów zatrzymuje blok i wymienia, czego brakuje", async () => {
  const ctx = { facts: { kwota_kredytu: 42000, prowizja: null } };

  await assert.rejects(
    () => runStep(block, ctx, CONFIG),
    (error) => /brak faktów do przeliczenia: prowizja, liczba_rat, rata_miesieczna/.test(error.message),
  );
});

test("kontrakt bloku zgadza się z tym, co blok naprawdę robi", async () => {
  assert.equal(block.report, true); // wynik dla człowieka, nie półprodukt

  const ctx = { facts: FIELDS };
  await runStep(block, ctx, CONFIG);

  // Checklista adresuje te ścieżki po nazwie. Rozjazd deklaracji z wynikiem to
  // warunek, który zawsze milczy albo zawsze oskarża — nie do wychwycenia okiem.
  assert.deepEqual(
    block.provides,
    Object.keys(ctx.calculations).map((key) => `calculations.${key}`),
  );
});
