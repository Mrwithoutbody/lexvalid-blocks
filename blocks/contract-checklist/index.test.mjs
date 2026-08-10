import { test } from "node:test";
import assert from "node:assert/strict";

import block from "./index.mjs";
import { plural } from "../../../src/contract/plural.mjs";
import { runStep } from "../../../src/engine/index.mjs";

// Mechanika operatorów stoi w `src/conditions.test.mjs` — wspólny język
// warunków testuje się raz. Tu wyłącznie to, co dokłada checklista: zbieranie
// naruszeń, wagi i kontrakt bloku.
const CTX = {
  facts: { oprocentowanie: 9.5, termin_odstapienia_dni: null, bank: "" },
  calculations: { rrso_gap: 5.19, excess_over_limit: 0, non_interest_limit: 10000 },
};

// ── polska odmiana ───────────────────────────────────────────────────────

/** Odmiana stoi w `src/plural.mjs` — jedna reguła na bloki, które jej używają. */
test("odmiana po liczbie", () => {
  const violations = (n) => plural(n, "naruszenie", "naruszenia", "naruszeń");

  assert.equal(violations(0), "0 naruszeń");
  assert.equal(violations(1), "1 naruszenie");
  assert.equal(violations(2), "2 naruszenia");
  assert.equal(violations(5), "5 naruszeń");
  assert.equal(violations(12), "12 naruszeń"); // wyjątek dla 12-14
  assert.equal(violations(22), "22 naruszenia");
  assert.equal(violations(25), "25 naruszeń");
});

// ── blok w całości ───────────────────────────────────────────────────────

const ITEMS = [
  {
    kod: "ART30_1_7_RRSO",
    waga: "krytyczny",
    podstawa: "art. 30 ust. 1 pkt 7 UKK",
    opis: "RRSO w umowie nie zgadza się z przeliczonym",
    gdy: ["calculations.rrso_gap", ">", 0.1],
  },
  {
    kod: "ART30_1_15_ODSTAPIENIE",
    waga: "istotny",
    podstawa: "art. 30 ust. 1 pkt 15 UKK",
    opis: "umowa nie podaje terminu odstąpienia",
    gdy: ["facts.termin_odstapienia_dni", "brak"],
  },
  {
    kod: "ART30_1_6_OPROCENTOWANIE",
    waga: "istotny",
    podstawa: "art. 30 ust. 1 pkt 6 UKK",
    opis: "umowa nie podaje oprocentowania",
    gdy: ["facts.oprocentowanie", "brak"],
  },
];

test("blok zbiera tylko naruszone pozycje i liczy krytyczne", async () => {
  const ctx = structuredClone(CTX);
  const { note } = await runStep(block, ctx, { pozycje: ITEMS });

  assert.deepEqual(
    ctx.checklist.findings.map((f) => f.kod),
    ["ART30_1_7_RRSO", "ART30_1_15_ODSTAPIENIE"],
  );
  assert.equal(ctx.checklist.checked, 3);
  assert.equal(ctx.checklist.critical, 1);
  assert.equal(note, "3 pozycje — 2 naruszenia, w tym 1 krytyczne");
});

test("zarzut niesie podstawę prawną, nie tylko kod", async () => {
  const ctx = structuredClone(CTX);
  await runStep(block, ctx, { pozycje: ITEMS });

  const rrso = ctx.checklist.findings.find((f) => f.kod === "ART30_1_7_RRSO");
  assert.equal(rrso.podstawa, "art. 30 ust. 1 pkt 7 UKK");
  assert.equal(rrso.waga, "krytyczny");
});

test("checklista działa bez przeliczeń — nie każdy rodzaj sprawy je ma", async () => {
  const ctx = { facts: { oprocentowanie: 9.5, termin_odstapienia_dni: null } };
  await runStep(block, ctx, { pozycje: ITEMS });

  // Pozycja odwołująca się do przeliczeń po prostu nie trafia.
  assert.deepEqual(
    ctx.checklist.findings.map((f) => f.kod),
    ["ART30_1_15_ODSTAPIENIE"],
  );
});

test("umowa bez wad daje pustą listę, nie brak wyniku", async () => {
  const ctx = {
    facts: { oprocentowanie: 9.5, termin_odstapienia_dni: 14 },
    calculations: { rrso_gap: 0, excess_over_limit: 0 },
  };
  const { note } = await runStep(block, ctx, { pozycje: ITEMS });

  assert.deepEqual(ctx.checklist.findings, []);
  assert.equal(ctx.checklist.critical, 0);
  assert.equal(note, "3 pozycje — 0 naruszeń");
});

test("pusta lista pozycji nie udaje, że coś sprawdziła", async () => {
  const ctx = structuredClone(CTX);
  const { note } = await runStep(block, ctx, {});

  assert.equal(ctx.checklist.checked, 0);
  assert.equal(note, "0 pozycji — 0 naruszeń");
});

test("zarzut z faktu niesie cytat z ekstrakcji, zarzut z przeliczeń nie udaje dowodu", async () => {
  const ctx = {
    ...structuredClone(CTX),
    evidence: { termin_odstapienia_dni: null, oprocentowanie: { cytat: "9,50% w skali roku", strona: 1 } },
  };
  await runStep(block, ctx, { pozycje: ITEMS });

  const findings = Object.fromEntries(ctx.checklist.findings.map((f) => [f.kod, f]));

  // Warunek `brak` na fakcie: dowodu nie ma i pusty dowód to właściwy komunikat
  // („zweryfikuj ręcznie") — nie wolno w to miejsce wstawiać niczego pewniejszego.
  assert.equal(findings.ART30_1_15_ODSTAPIENIE.dowod, null);
  // Zarzut z przeliczeń: cytatu nie ma z natury — metoda liczenia jest w
  // `calculations`, nie w cudzysłowie.
  assert.equal(findings.ART30_1_7_RRSO.dowod, null);
});

test("cytat dojeżdża do zarzutu, gdy ekstrakcja go potwierdziła", async () => {
  const pozycje = [
    {
      kod: "ZA_WYSOKO",
      waga: "istotny",
      podstawa: "art. testowy",
      opis: "oprocentowanie ponad próg",
      gdy: ["facts.oprocentowanie", ">", 5],
    },
  ];
  const ctx = {
    facts: { oprocentowanie: 9.5 },
    evidence: { oprocentowanie: { cytat: "Oprocentowanie: 9,50% w skali roku", strona: 1 } },
  };
  await runStep(block, ctx, { pozycje });

  assert.deepEqual(ctx.checklist.findings[0].dowod, {
    cytat: "Oprocentowanie: 9,50% w skali roku",
    strona: 1,
  });
});

test("orzeczenia z pozycji jadą do zarzutu, pozycja bez nich nie dostaje pustej listy", async () => {
  const orzeczenia = [{ sygnatura: "TSUE C-377/14", teza: "całkowita kwota kredytu bez skredytowanych kosztów" }];
  const pozycje = [
    { ...ITEMS[1], orzeczenia },
    ITEMS[0], // bez orzeczeń
  ];
  const ctx = structuredClone(CTX);
  await runStep(block, ctx, { pozycje });

  const [zOrzeczeniem, bez] = ctx.checklist.findings;
  assert.deepEqual(zOrzeczeniem.orzeczenia, orzeczenia);
  assert.ok(!("orzeczenia" in bez), "pusta lista udawałaby, że orzecznictwa szukano");
});

test("nieznany operator w pozycji to błąd konfiguracji, nie cicha nieprawda", async () => {
  const zepsute = [{ ...ITEMS[0], gdy: ["facts.oprocentowanie", "~=", 1] }];

  await assert.rejects(() => runStep(block, structuredClone(CTX), { pozycje: zepsute }), /nieznany operator/);
});

test("wymagania wychodzą z warunków, więc pipeline wie, co postawić wcześniej", () => {
  assert.deepEqual(block.requires({ pozycje: ITEMS }), [
    "calculations.rrso_gap",
    "facts.termin_odstapienia_dni",
    "facts.oprocentowanie",
  ]);

  // Krotność też sięga w kontekst — bez tego czynsz byłby cichym `undefined`,
  // a kaucja ponad limit przechodziłaby bez zarzutu.
  const deposit = { gdy: ["facts.kaucja", ">", { sciezka: "facts.czynsz_miesieczny", razy: 12 }] };
  assert.deepEqual(block.requires({ pozycje: [deposit] }), ["facts.kaucja", "facts.czynsz_miesieczny"]);

  assert.deepEqual(block.requires({}), [], "pusta checklista niczego nie wymaga");
});

test("kontrakt bloku zgadza się z tym, co blok naprawdę robi", async () => {
  assert.equal(block.report, true); // wynik dla człowieka, nie półprodukt

  const ctx = structuredClone(CTX);
  await runStep(block, ctx, { pozycje: ITEMS });
  for (const path of block.provides) {
    const [root, key] = path.split(".");
    assert.ok(ctx[root]?.[key] !== undefined, `blok nie ustawił ${path}`);
  }
});

// ── widoki: karta zarzutu i zaznaczenie cytatu ───────────────────────────

test("widoki oddają kartę zarzutu i zaznaczenie jego cytatu", () => {
  const widoki = block.widoki({
    checklist: {
      checked: 3,
      findings: [
        {
          kod: "R-001",
          waga: "krytyczny",
          opis: "Brak RRSO.",
          podstawa: "art. 30",
          dowod: { cytat: "RRSO wynosi" },
        },
      ],
    },
  });

  const [karty, zaznaczenia] = widoki;

  assert.equal(karty.widzet, "karty");
  assert.match(karty.tytul, /1 z 3/);
  assert.equal(karty.karty[0].ton, "blad");
  assert.equal(karty.karty[0].zaznaczenie, "mark-R-001");
  assert.equal(karty.karty[0].szczegoly[0].tekst, "art. 30");

  assert.equal(zaznaczenia.widzet, "zaznaczenia");
  assert.equal(zaznaczenia.zaznaczenia[0].cytat, "RRSO wynosi");
  assert.equal(zaznaczenia.zaznaczenia[0].ranga, 0);
});

test("czysta checklista mówi to zdaniem, nie pustką", () => {
  const [akapit] = block.widoki({ checklist: { checked: 5, findings: [] } });

  assert.equal(akapit.widzet, "akapit");
  assert.match(akapit.tekst, /Żadna z 5/);
});
