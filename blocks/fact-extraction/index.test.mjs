import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import block, { factsFrom } from "./index.mjs";
import { runStep } from "../../../src/engine/index.mjs";

/**
 * Blok jest jednym wywołaniem modelu, więc testujemy to, co robi z odpowiedzią,
 * a nie sam model. `fetch` podmieniony — testy nie chodzą do sieci i nie kosztują.
 */
const realFetch = globalThis.fetch;
const realKey = process.env.OPENAI_API_KEY;

after(() => {
  globalThis.fetch = realFetch;
  process.env.OPENAI_API_KEY = realKey;
});

/** Ostatnie żądanie wysłane do modelu — do sprawdzenia, co poszło w prompcie. */
let sent;

const answering = (content, { ok = true, status = 200 } = {}) => {
  globalThis.fetch = async (url, options) => {
    sent = JSON.parse(options.body);
    return {
      ok,
      status,
      text: async () => "szczegóły błędu",
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    };
  };
};

const STEP = { pola: ["kwota_kredytu", "prowizja"] };

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test";
  sent = undefined;
});

test("bez klucza blok mówi czego brakuje, zamiast strzelać w sieć", async () => {
  delete process.env.OPENAI_API_KEY;
  globalThis.fetch = () => assert.fail("nie wolno wołać modelu bez klucza");

  await assert.rejects(() => runStep(block, { text: { safe: "cokolwiek" } }, STEP), /brak OPENAI_API_KEY/);
});

test("do kontekstu wchodzą wyłącznie pola, o które pytaliśmy", async () => {
  // Model przekręcił nazwę (prowizja → oplata) i dorzucił pole spoza listy.
  answering({ kwota_kredytu: 42000, oplata: 5100, bank: "Testowy S.A." });

  const ctx = { text: { safe: "umowa" } };
  const { note } = await runStep(block, ctx, STEP);

  // `prowizja` jako null, nie 5100 pod cudzą nazwą: przeliczenia zatrzymają się
  // na braku faktu, zamiast policzyć RRSO z wartości, której nikt nie pytał.
  assert.deepEqual(ctx.facts, { kwota_kredytu: 42000, prowizja: null });
  assert.match(note, /model zmyślił klucze: oplata, bank/);
});

test("ucięcie umowy trafia do śladu, nie ginie po cichu", async () => {
  answering({ kwota_kredytu: 42000, prowizja: 5100 });

  const ctx = { text: { safe: "x".repeat(500) } };
  const { note } = await runStep(block, ctx, { ...STEP, limit_znakow: 100 });

  assert.match(note, /tekst ucięty do 100 z 500 znaków/);
  // Bez tego ostrzeżenia ucięta umowa wygląda na umowę bez tych informacji,
  // a checklista robi z niej zarzut z art. 30.
  assert.equal(sent.messages.at(-1).content.length, 100);
});

test("umowa w limicie nie dostaje ostrzeżenia, a ta sama daje ten sam wynik", async () => {
  answering({ kwota_kredytu: 42000, prowizja: 5100 });

  const { note } = await runStep(block, { text: { safe: "krótka umowa" } }, STEP);

  assert.doesNotMatch(note, /ucięty|zmyślił/);
  assert.equal(sent.temperature, 0);
});

test("bez limitu w konfiguracji idzie cały tekst — klauzule mieszkają na końcu umowy", async () => {
  answering({ kwota_kredytu: 42000, prowizja: 5100 });

  // 30k znaków — więcej niż dawny cichy limit, który ucinał klauzulę
  // odstąpienia i robił z tego zarzut z art. 30.
  const { note } = await runStep(block, { text: { safe: "x".repeat(30000) } }, STEP);

  assert.equal(sent.messages.at(-1).content.length, 30000);
  assert.doesNotMatch(note, /ucięty/);
});

test("schemat strict wymusza pola z kroku — przekręcony klucz nie jest już możliwy", async () => {
  answering({ kwota_kredytu: 42000, prowizja: 5100 });

  await runStep(block, { text: { safe: "umowa" } }, STEP);

  const format = sent.response_format;
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.strict, true);
  assert.deepEqual(format.json_schema.schema.required, ["kwota_kredytu", "prowizja"]);
  // Każde pole musi przyjść jako {value, cytat, strona} — kształt dowodu
  // wymusza schemat, prawdę cytatu sprawdza factsFrom.
  assert.deepEqual(format.json_schema.schema.properties.prowizja.required, ["value", "cytat", "strona"]);
});

test("błąd modelu zatrzymuje pipeline z kodem odpowiedzi", async () => {
  answering({}, { ok: false, status: 429 });

  await assert.rejects(() => runStep(block, { text: { safe: "umowa" } }, STEP), /OpenAI 429/);
});

// ── opis pola ────────────────────────────────────────────────────────────

/**
 * Postanowienie umowne nazwy nie ma. Bez zdania, czego szukać, model oddaje na
 * nie `null` również wtedy, gdy umowa je zawiera — a checklista czyta `null`
 * jako brak naruszenia i zarzut po prostu nie powstaje.
 */
test("opis pola idzie do promptu, gołe nazwy jednym wierszem", async () => {
  answering({ prowizja: 5100, klauzula_odstapienia: null });

  await runStep(block, 
    { text: { safe: "umowa" } },
    {
      pola: [
        "prowizja",
        { id: "klauzula_odstapienia", opis: "przepisz postanowienie o prawie odstąpienia" },
      ],
    },
  );

  const prompt = sent.messages[0].content;
  assert.match(prompt, /Klucze bez dodatkowych wskazówek: prowizja\./);
  assert.match(prompt, /klauzula_odstapienia: przepisz postanowienie o prawie odstąpienia/);
});

test("pole opisane deklaruje się tak samo jak gołe", () => {
  const step = { pola: ["prowizja", { id: "klauzula_odstapienia", opis: "cokolwiek" }] };

  assert.deepEqual(block.provides(step), [
    "facts.prowizja",
    "evidence.prowizja",
    "facts.klauzula_odstapienia",
    "evidence.klauzula_odstapienia",
  ]);
});

test("pole bez nazwy zatrzymuje krok, zamiast pytać model o pusty klucz", () => {
  assert.throws(() => block.provides({ pola: [{ opis: "sam opis" }] }), /pole ekstrakcji bez nazwy/);
});

// ── dowód przy fakcie ────────────────────────────────────────────────────

const TEXT = "=== Strona 1 ===\nKwota kredytu: 42000,00 zl\nProwizja: 5100,00 zl";

test("cytat obecny w tekście zostaje dowodem, z numerem strony", () => {
  const { facts, evidence } = factsFrom(
    { kwota_kredytu: { value: 42000, cytat: "Kwota kredytu: 42000,00 zl", strona: 1 } },
    ["kwota_kredytu"],
    TEXT,
  );

  assert.equal(facts.kwota_kredytu, 42000);
  assert.deepEqual(evidence.kwota_kredytu, { cytat: "Kwota kredytu: 42000,00 zl", strona: 1 });
});

test("zmyślony cytat odpada, wartość zostaje bez pokrycia", () => {
  // Konfabulacja pokazana jako dowód czytałaby się jak „sprawdzone" —
  // pusty dowód mówi „zweryfikuj ręcznie" i to jest właściwy komunikat.
  const { facts, evidence, fabricated } = factsFrom(
    { prowizja: { value: 5100, cytat: "Prowizja wynosi 5100 zł (słownie...)", strona: 1 } },
    ["prowizja"],
    TEXT,
  );

  assert.equal(facts.prowizja, 5100);
  assert.equal(evidence.prowizja, null);
  assert.deepEqual(fabricated, ["prowizja"]);
});

test("cytat porównuje się po zwinięciu białych znaków, nie po łamaniu wierszy", () => {
  const { evidence } = factsFrom(
    { kwota_kredytu: { value: 42000, cytat: "Kwota kredytu:\n42000,00   zl", strona: 1 } },
    ["kwota_kredytu"],
    TEXT,
  );

  assert.ok(evidence.kwota_kredytu, "łamanie wierszy w PDF nie może kasować prawdziwego cytatu");
});

test("goła wartość bez obiektu dalej wchodzi — dowód po prostu pusty", () => {
  const { facts, evidence } = factsFrom({ prowizja: 5100 }, ["prowizja"], TEXT);

  assert.equal(facts.prowizja, 5100);
  assert.equal(evidence.prowizja, null);
});

test("null nie dostaje dowodu, nawet gdy model jakiś dokleił", () => {
  const { evidence } = factsFrom(
    { rrso: { value: null, cytat: "Kwota kredytu: 42000,00 zl", strona: 1 } },
    ["rrso"],
    TEXT,
  );

  assert.equal(evidence.rrso, null, "cytat przy braku wartości niczego nie dowodzi");
});

test("blok obiecuje fakt i dowód parami, oba korzenie idą do raportu", () => {
  assert.deepEqual(block.provides({ pola: ["prowizja"] }), ["facts.prowizja", "evidence.prowizja"]);
  assert.deepEqual(block.report, ["facts", "evidence"]);
});

test("run zostawia dowody w kontekście i liczy je w śladzie", async () => {
  answering({
    kwota_kredytu: { value: 42000, cytat: "Kwota 42000", strona: 1 },
    prowizja: { value: 5100, cytat: "nie ma takiego zdania", strona: 2 },
  });

  const ctx = { text: { safe: "=== Strona 1 ===\nKwota 42000. Prowizja 5100." } };
  const { note } = await runStep(block, ctx, STEP);

  assert.deepEqual(ctx.facts, { kwota_kredytu: 42000, prowizja: 5100 });
  assert.deepEqual(ctx.evidence.kwota_kredytu, { cytat: "Kwota 42000", strona: 1 });
  assert.equal(ctx.evidence.prowizja, null);
  assert.match(note, /1\/2 faktów z cytatem/);
  assert.match(note, /cytaty spoza tekstu odrzucone: prowizja/);
});
