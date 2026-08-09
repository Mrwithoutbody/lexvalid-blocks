import { test } from "node:test";
import assert from "node:assert/strict";

import block, { fillTemplate } from "./index.mjs";
import { runStep } from "../../../src/engine/index.mjs";

const SZABLON = `{facts.bank}

OŚWIADCZENIE

Dotyczy: umowy z dnia {facts.data_umowy}

{checklist.findings:zarzuty}

Wzywam do zwrotu {calculations.claim:zl}.

---
[NOTATKA WEWNĘTRZNA — USUNĄĆ PRZED WYSŁANIEM] Termin: {deadline.status}. {deadline.opis}`;

const SPRAWA = {
  facts: { bank: "Bank Testowy S.A.", data_umowy: "2024-03-15" },
  calculations: { claim: 4231.5 },
  checklist: {
    findings: [
      { kod: "R1", podstawa: "art. 30 ust. 1 pkt 7 UKK", opis: "RRSO w umowie nie zgadza się z przeliczonym" },
      {
        kod: "R2",
        podstawa: "art. 30 ust. 1 pkt 6 UKK [DO WERYFIKACJI P]",
        opis: "Umowa nie podaje oprocentowania. [może to być też luka ekstrakcji]",
      },
    ],
  },
  deadline: { status: "sporny", opis: "Wykładnie się rozchodzą — wymaga oceny prawnika." },
};

const KROK = {
  szablon: SZABLON,
  odmowa_gdy: ["deadline.status", "=", "wygasly"],
  odmowa_powod: "uprawnienie wygasło",
};

// ── podstawianie ─────────────────────────────────────────────────────────

test("pismo niesie fakty sprawy, nie puste nawiasy", () => {
  const pismo = fillTemplate(SZABLON, SPRAWA);

  assert.match(pismo, /Bank Testowy S\.A\./);
  assert.match(pismo, /z dnia 2024-03-15/);
  assert.match(pismo, /4231,50 zł/);
  assert.match(pismo, /1\. RRSO w umowie nie zgadza się/);
});

test("notatki warsztatowe z zarzutów nie idą do adresata", () => {
  const pismo = fillTemplate(SZABLON, SPRAWA);

  // „[DO WERYFIKACJI P]" przy podstawie i „[może to być luka ekstrakcji]"
  // w opisie czytałyby się jak przyznanie, że zarzut jest niepewny.
  assert.ok(!pismo.includes("DO WERYFIKACJI"));
  assert.ok(!pismo.includes("luka ekstrakcji"));
  assert.match(pismo, /2\. Umowa nie podaje oprocentowania\. \(art\. 30 ust\. 1 pkt 6 UKK\)/);
});

test("czego kontekst nie wie, zostaje do uzupełnienia — pismo nie zmyśla", () => {
  const bezBanku = { ...SPRAWA, facts: { data_umowy: "2024-03-15" } };
  const pismo = fillTemplate(SZABLON, bezBanku);

  assert.match(pismo, /^\[DO UZUPEŁNIENIA\]/);
});

test("pusta lista zarzutów to pole do uzupełnienia, nie pusty akapit", () => {
  const pismo = fillTemplate(SZABLON, { ...SPRAWA, checklist: { findings: [] } });

  assert.match(pismo, /\[DO UZUPEŁNIENIA\]\n\nWzywam/);
});

test("obiekt bez filtra nie wkleja się jako bełkot", () => {
  const pismo = fillTemplate("{checklist.findings}", SPRAWA);

  assert.equal(pismo, "[DO UZUPEŁNIENIA]");
});

// ── odmowa ───────────────────────────────────────────────────────────────

test("po terminie pismo się nie składa — to werdykt, nie awaria", async () => {
  const ctx = { ...structuredClone(SPRAWA), deadline: { status: "wygasly", opis: "…" } };

  // Wysłane po terminie wprowadzałoby klienta w błąd co do uprawnienia,
  // którego już nie ma.
  await assert.rejects(() => runStep(block, ctx, KROK), (error) => {
    assert.deepEqual(error.rejections, ["uprawnienie wygasło"]);
    return true;
  });
  assert.equal(ctx.statement, undefined);
});

test("otwarty termin przepuszcza pismo z notatką pod kreską", async () => {
  const ctx = structuredClone(SPRAWA);
  const { note } = await runStep(block, ctx, KROK);

  const [tresc, notatka] = ctx.statement.split("\n---\n");
  assert.ok(!tresc.includes("NOTATKA WEWNĘTRZNA"));
  assert.match(notatka, /sporny/);
  assert.match(note, /pismo złożone/);
});

// ── kontrakt ─────────────────────────────────────────────────────────────

test("wymagania wychodzą z szablonu i warunku odmowy", () => {
  assert.deepEqual(block.requires(KROK), [
    "facts.bank",
    "facts.data_umowy",
    "checklist.findings",
    "calculations.claim",
    "deadline.status",
    "deadline.opis",
  ]);
});

test("nieznany filtr wychodzi przy zapisie, nie na pierwszej sprawie", () => {
  assert.throws(() => block.requires({ szablon: "{calculations.claim:eur}" }), /nieznany filtr "eur"/);
});

test("krok bez szablonu nie udaje pisma", async () => {
  await assert.rejects(() => runStep(block, structuredClone(SPRAWA), {}), /bez `szablon`/);
});

test("ślad mówi, ile pól zostało do ręcznego uzupełnienia", async () => {
  const ctx = { ...structuredClone(SPRAWA), facts: {} };
  const { note } = await runStep(block, ctx, { szablon: SZABLON });

  assert.match(note, /2 pola do uzupełnienia/);
});
