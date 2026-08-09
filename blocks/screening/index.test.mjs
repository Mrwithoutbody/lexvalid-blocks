import { test } from "node:test";
import assert from "node:assert/strict";

import block from "./index.mjs";
import { runStep } from "../../../src/engine/index.mjs";

/**
 * Kwalifikacja to najtańsza bramka w systemie: za nią jest dokument klienta
 * i płatne wywołanie modelu. Każdy jej błąd kosztuje albo przyjętą sprawę,
 * której nie wolno było przyjąć, albo odrzuconą, która się kwalifikowała.
 *
 * Progi są WYMYŚLONE, okrągłe. Nie ma tu daty wejścia ustawy ani limitu kwoty —
 * te stoją w `case-types/*.json` i podlegają prawnikowi. Wpisane tutaj czytałyby
 * się jak wymaganie, a testowałyby tylko, że pamiętam, co sam wpisałem.
 * Ten plik sprawdza mechanikę bramki: czy odrzuca, kiedy warunek zapala.
 */
const PYTANIA = {
  pytania: [
    {
      id: "data_zdarzenia",
      typ: "data",
      pytanie: "Data zdarzenia",
      blokuj_gdy: ["<", "2020-01-01"],
      powod: "za stare",
    },
    {
      id: "kwota",
      typ: "kwota",
      pytanie: "Kwota",
      blokuj_gdy: [">", 100000],
      powod: "za dużo",
    },
    {
      id: "konsument",
      typ: "tak-nie",
      pytanie: "Kredyt na cel niezawodowy?",
      blokuj_gdy: ["=", false],
      powod: "kredyt firmowy",
    },
  ],
};

const KOMPLET = { data_zdarzenia: "2025-04-11", kwota: 42000, konsument: true };

const KREDYT = { slowa_kluczowe: ["kredyt konsumencki", "RRSO", "harmonogram spłat", "kredytodawca"] };

// ── sito dokumentu: słowa kluczowe ───────────────────────────────────────

test("dokument z tego rodzaju sprawy przechodzi", async () => {
  const ctx = { text: { raw: "Umowa o kredyt konsumencki. RRSO wynosi 12%. Harmonogram spłat w załączniku." } };
  const { note } = await runStep(block, ctx, KREDYT);

  assert.equal(ctx.classification.dopasowanie, 0.75);
  assert.match(note, /3\/4/);
});

test("obcy dokument zatrzymuje pipeline przed wywołaniem modelu", async () => {
  // Umowa najmu w pipelinie kredytowym skończyłaby się checklistą zarzutów
  // postawionych dokumentowi, którego nikt pod tym kątem nie czytał.
  const ctx = { text: { raw: "Umowa najmu lokalu mieszkalnego. Czynsz płatny do 10 dnia miesiąca." } };

  await assert.rejects(() => runStep(block, ctx, KREDYT), /nie wygląda na ten rodzaj sprawy/);
});

test("próg jest ułamkiem listy, nie liczbą trafień", async () => {
  const ctx = { text: { raw: "Umowa o kredyt konsumencki." } };

  // 1 z 4 to 25% — dopisanie synonimu do listy nie może rozluźniać kontroli.
  await assert.rejects(() => runStep(block, ctx, KREDYT));
  assert.equal((await runStep(block, ctx, { ...KREDYT, prog: 0.25 })).note.startsWith("1/4"), true);
});

test("ogonki nie decydują o dopasowaniu — skan po OCR wraca bez nich", async () => {
  const ctx = { text: { raw: "Calkowita kwota do zaplaty: 50400 zl" } };
  const { note } = await runStep(block, ctx, { slowa_kluczowe: ["całkowita kwota do zapłaty"], prog: 1 });

  assert.match(note, /1\/1/);
});

// ── sito zgłoszenia: pytania ─────────────────────────────────────────────

test("sprawa spełniająca warunki przechodzi i zostawia ślad w kontekście", async () => {
  const ctx = { answers: { ...KOMPLET } };
  const { note } = await runStep(block, ctx, PYTANIA);

  assert.deepEqual(ctx.qualification, { pytania: 3 });
  assert.match(note, /3 pytania/);
});

test("każdy zapalony warunek to powód odrzucenia, jadą listą", async () => {
  const ctx = { answers: { data_zdarzenia: "2019-06-01", kwota: 150000, konsument: true } };

  // Odrzucenie to werdykt, nie awaria — interfejs czyta `rejections`,
  // a nie wyłuskuje powodów z tekstu błędu.
  await assert.rejects(() => runStep(block, ctx, PYTANIA), (error) => {
    assert.deepEqual(error.rejections, ["za stare", "za dużo"]);
    return true;
  });
});

test("odpowiedź tak-nie odrzuca po równości, nie po obecności", async () => {
  const ctx = { answers: { ...KOMPLET, konsument: false } };

  await assert.rejects(() => runStep(block, ctx, PYTANIA), (error) => {
    assert.deepEqual(error.rejections, ["kredyt firmowy"]);
    return true;
  });
});

test("literówka w operatorze to błąd konfiguracji z nazwą pytania", async () => {
  const krok = { pytania: [{ id: "kwota", blokuj_gdy: ["~=", 5], powod: "x" }] };

  // Warunek, który „nigdy nie zachodzi", wyglądałby jak poprawna odpowiedź —
  // a to bramka stojąca przed dokumentem klienta.
  await assert.rejects(() => runStep(block, { answers: { kwota: 5 } }, krok), /nieznany operator.*kwota/);
});

// ── oba sita naraz i kontrakt ────────────────────────────────────────────

test("słowa kluczowe i pytania działają w jednym kroku", async () => {
  const ctx = {
    text: { raw: "Umowa o kredyt konsumencki. RRSO 12%. Harmonogram spłat. Kredytodawca: bank." },
    answers: { ...KOMPLET },
  };
  const { note } = await runStep(block, ctx, { ...KREDYT, ...PYTANIA });

  assert.match(note, /4\/4 słów kluczowych/);
  assert.match(note, /sprawa kwalifikuje się/);
});

test("krok bez obu sit to błąd konfiguracji, nie ciche przepuszczenie", async () => {
  await assert.rejects(() => runStep(block, { text: { raw: "cokolwiek" } }, {}), /slowa_kluczowe.*pytania/);
});

test("wymagania i obietnice idą za konfiguracją kroku", () => {
  assert.deepEqual(block.requires(KREDYT), ["text.raw"]);
  assert.deepEqual(block.requires(PYTANIA), ["answers.data_zdarzenia", "answers.kwota", "answers.konsument"]);
  assert.deepEqual(block.requires({ ...KREDYT, ...PYTANIA })[0], "text.raw");

  assert.deepEqual(block.provides(PYTANIA), ["qualification.pytania"]);
  assert.deepEqual(block.provides(KREDYT), [
    "classification.dopasowanie",
    "classification.trafione",
    "classification.brakujace",
  ]);
});

test("formularz pyta dokładnie o skonfigurowane pytania", () => {
  assert.deepEqual(block.form(PYTANIA).map((field) => field.id), ["data_zdarzenia", "kwota", "konsument"]);
  assert.deepEqual(block.form(KREDYT), [], "sito dokumentu nie pyta człowieka o nic");
});
