import { test } from "node:test";
import assert from "node:assert/strict";

import block, { leftovers, pseudonymize } from "./index.mjs";
import { scan, splitNames } from "./patterns.mjs";
import { runStep } from "../../../src/engine/index.mjs";

const PESEL = "44051401359";

test("identyfikator znika z tekstu i zostawia etykietę", () => {
  const { text } = pseudonymize(`Kredytobiorca, PESEL ${PESEL}, e-mail jan@example.com`);

  assert.ok(!text.includes(PESEL));
  assert.ok(!text.includes("jan@example.com"));
  assert.match(text, /\[PESEL-1\]/);
  assert.match(text, /\[EMAIL-1\]/);
});

test("ta sama wartość dostaje wszędzie tę samą etykietę", () => {
  // Inaczej model przestaje widzieć, że to dwa razy ten sam rachunek.
  const { text } = pseudonymize(`PESEL ${PESEL} … ponownie ${PESEL}`);

  assert.equal(text.match(/\[PESEL-1\]/g).length, 2);
  assert.ok(!text.includes("[PESEL-2]"));
});

test("adres schodzi pod etykietę razem z numerem mieszkania", () => {
  const { text } = pseudonymize("Zamieszkały ul. Kwiatowa 12/3, 00-001 Warszawa");

  assert.ok(!text.includes("Kwiatowa"));
  assert.ok(!text.includes("00-001"));
  assert.match(text, /\[ADRES-1\]/);
  assert.match(text, /\[ADRES-2\]/);
});

test("nazwisko znika w każdej odmianie, nie tylko w mianowniku", () => {
  const umowa =
    "Zawarta pomiędzy Janem Kowalskim a najemcą. Kowalski oświadcza, " +
    "że lokal wydano Kowalskiemu w dniu podpisania.";

  const { text } = pseudonymize(umowa, ["Jan Kowalski"]);

  for (const forma of ["Janem", "Kowalskim", "Kowalski", "Kowalskiemu"]) {
    assert.ok(!text.includes(forma), `została forma „${forma}"`);
  }

  // Wszystkie warianty jednej osoby to ten sam numer — inaczej model widziałby
  // czterech różnych ludzi tam, gdzie jest jeden.
  assert.ok(!text.includes("[OSOBA-2]"));
});

test("inicjał nie maskuje pół umowy", () => {
  // Człon krótszy niż trzy znaki odpada: „J." trafiłoby w każde słowo na „j".
  const { text } = pseudonymize("Jan J. Kowalski jedzie do Jastrzębia.", ["Jan J. Kowalski"]);

  assert.match(text, /jedzie do Jastrzębia/);
});

test("strony przychodzą z formularza jako wiersze albo lista po przecinku", () => {
  assert.deepEqual(splitNames("Jan Kowalski\nAnna Nowak"), ["Jan Kowalski", "Anna Nowak"]);
  assert.deepEqual(splitNames("Jan Kowalski, Anna Nowak"), ["Jan Kowalski", "Anna Nowak"]);
  assert.deepEqual(splitNames("  "), []);
  assert.deepEqual(splitNames(undefined), []);
});

test("to, co przeszło pseudonimizację, przechodzi też guard", () => {
  const { text } = pseudonymize(`PESEL ${PESEL}, NIP 5252248481, rachunek 61109010140000071219812874`);

  assert.deepEqual(scan(text), [], "guard nie może znaleźć niczego po maskowaniu");
});

// ── co zostało po podmianie ──────────────────────────────────────────────

test("trafienie nigdy nie niesie pełnej wartości", () => {
  const [trafienie] = leftovers(`PESEL ${PESEL}`, []);

  assert.ok(!trafienie.fragment.includes(PESEL), "fragment nie może być całym numerem");
  assert.match(trafienie.fragment, /\*/);
});

test("nazwisko, które przetrwało podmianę, jest trafieniem", () => {
  // Kontrola nie zgaduje, kto jest osobą — sprawdza, czy podmiana zrobiła swoje.
  const trafienia = leftovers("Umowa zawarta z Janem Kowalskim.", ["Jan Kowalski"]);

  assert.deepEqual(
    trafienia.map((t) => t.fragment),
    ["J***", "K***"],
    "trafienie niesie inicjał, nie nazwisko",
  );
});

// ── klocek w całości ─────────────────────────────────────────────────────

test("klocek podmienia treść i raportuje samą statystykę", async () => {
  const ctx = { text: { raw: `PESEL ${PESEL}, e-mail jan@example.com` }, answers: { strony: "" } };
  const { note } = await runStep(block, ctx, {});

  assert.ok(!ctx.text.safe.includes(PESEL));
  assert.equal(ctx.pseudonymization.podstawien, 2);

  // `text.raw` zostaje nietknięte: to dwie różne treści i dwa różne prawa do
  // nich, więc jedna nie może nadpisywać drugiej.
  assert.ok(ctx.text.raw.includes(PESEL));

  // Do raportu idzie liczba, nigdy oryginał.
  assert.ok(!JSON.stringify(ctx.pseudonymization).includes(PESEL));
  assert.match(note, /2 podstawień/);
  assert.match(note, /wzorce czyste/);
});

test("kontrola jest szersza niż podmiana i przy wątpliwości zatrzymuje", async () => {
  // Podmiana bierze końcówkę fleksyjną do trzech znaków, kontrola samą podstawę.
  // „Nowakowskiego" przechodzi podmianę i zapala kontrolę — a fałszywe trafienie
  // jest tu tańsze niż nazwisko wysłane do modelu.
  const ctx = { text: { raw: "Sprawa Nowakowskiego." }, answers: { strony: "Anna Nowak" } };

  await assert.rejects(() => runStep(block, ctx, {}), /dane osobowe.*nazwisko/);
  assert.equal(ctx.pseudonymization.trafienia.length, 1, "ślad powstaje mimo zatrzymania");
});

test("blokuj „nie” przepuszcza dalej, ale zostawia ślad", async () => {
  // Do przebiegu na umowach testowych, gdzie brak PII potwierdził człowiek.
  const ctx = { text: { raw: "Sprawa Nowakowskiego." }, answers: { strony: "Anna Nowak" } };
  const { note } = await runStep(block, ctx, { blokuj: "nie" });

  assert.equal(ctx.pseudonymization.trafienia.length, 1);
  assert.match(note, /1 trafień po podmianie/);
});
