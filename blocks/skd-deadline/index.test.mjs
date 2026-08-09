import { test } from "node:test";
import assert from "node:assert/strict";

import block, { computeDeadline } from "./index.mjs";
import { runStep } from "../../../src/engine/index.mjs";

// Normalizacja dat i arytmetyka miesięcy testują się w `src/dates.test.mjs`.

// ── dwie wykładnie „dnia wykonania umowy" ────────────────────────────────

const fields = (data_umowy, liczba_rat) => ({ data_umowy, liczba_rat });

test("uprawnienie otwarte, gdy nie minęło w żadnej wykładni", () => {
  const termin = computeDeadline(fields("2025-01-10", 36), "2025-06-01");

  assert.equal(termin.status, "otwarty");
  assert.equal(termin.wyplata.wygasa, "2026-01-10");
  assert.equal(termin.splata.wygasa, "2029-01-10");
});

test("rozejście się wykładni to spór, nie rozstrzygnięcie", () => {
  // Wypłata: rok od zawarcia minął. Spłata: harmonogram sięga 2027, więc biegnie.
  const termin = computeDeadline(fields("2024-01-01", 36), "2025-06-01");

  assert.equal(termin.status, "sporny");
  assert.equal(termin.wyplata.minal, true);
  assert.equal(termin.splata.minal, false);
  assert.match(termin.opis, /linii orzeczniczej/);
});

test("wygasłe w obu wykładniach zamyka sprawę", () => {
  const termin = computeDeadline(fields("2020-01-01", 12), "2025-06-01");

  assert.equal(termin.status, "wygasly");
  assert.match(termin.opis, /wyłącznie informacyjne/);
});

test("bez daty zawarcia nie zgadujemy terminu", () => {
  const termin = computeDeadline(fields(null, 36), "2025-06-01");

  assert.equal(termin.status, "nieznany");
  assert.equal(termin.zrodlo_daty_splaty, "brak danych");
});

test("faktyczna data spłaty bije harmonogram planowy", () => {
  const zHarmonogramu = computeDeadline(fields("2024-01-01", 36), "2025-06-01");
  assert.equal(zHarmonogramu.zrodlo_daty_splaty, "harmonogram planowy");
  assert.match(zHarmonogramu.opis, /wcześniejsza spłata przesuwa termin wstecz/);

  const zDokumentu = computeDeadline(
    { data_umowy: "2024-01-01", liczba_rat: 36, data_calkowitej_splaty: "2024-06-30" },
    "2025-06-01",
  );

  assert.equal(zDokumentu.zrodlo_daty_splaty, "z dokumentu");
  assert.equal(zDokumentu.splata.wygasa, "2025-06-30", "rok od faktycznej spłaty, nie od harmonogramu");
});

// ── klocek ───────────────────────────────────────────────────────────────

test("wynik niesie zastrzeżenie o spornej wykładni", async () => {
  const ctx = { facts: fields("2025-01-10", 36) };
  await runStep(block, ctx, { na_dzien: "2025-06-01" });

  assert.equal(ctx.deadline.status, "otwarty");

  // Blok liczy obie wykładnie „dnia wykonania umowy" i sporu nie rozstrzyga.
  // Znacznik musi dojechać do raportu, inaczej wynik wygląda na przesądzony.
  // Sam numer artykułu asercji nie dostaje: blok wpisuje go stałą, więc test
  // sprawdzałby wyłącznie, czy ktoś nie zmienił napisu.
  assert.match(ctx.deadline.podstawa, /DO WERYFIKACJI P/);
});
