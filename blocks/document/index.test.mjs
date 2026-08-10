import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import block from "./index.mjs";
import { runStep } from "../../../src/engine/index.mjs";

/**
 * PDF z jedną stroną i bez ani jednego znaku — tyle, ile zostaje ze zdjęcia
 * umowy: strona jest, treści nie ma. Budujemy go tutaj zamiast trzymać plik
 * w `test-contracts/`, bo tam leżą umowy do przebiegu sprawy, a to nie jest
 * umowa i nie ma rodzaju sprawy, do którego by należał.
 */
function stronaBezTekstu() {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<<>>/Contents 4 0 R>>",
    // Prostokąt: strona ma co rysować, więc nie odpada na tym, że jest pusta.
    "<</Length 31>>\nstream\n0 0 0 rg 100 100 200 200 re f\nendstream",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];

  for (const [i, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

test("umowa z warstwą tekstową przechodzi", async () => {
  const ctx = { source: { document: readFileSync(new URL("../../../test-contracts/skd-konsumencki.pdf", import.meta.url)) } };
  const { note } = await runStep(block, ctx);

  assert.match(note, /warstwy tekstowej/);
  assert.match(ctx.text.raw, /RRSO/);

  // Znacznik strony przy treści — z niego ekstrakcja podaje stronę cytatu,
  // a bez strony dowodu nie da się odszukać w umowie na biurku.
  assert.match(ctx.text.raw, /^=== Strona 1 ===\n/);
});

/**
 * Blok zatrzymuje pipeline, zamiast po cichu oddać pusty tekst — pusty
 * skończyłby się kompletem zarzutów z art. 30 postawionych umowie, której nikt
 * nie przeczytał.
 */
test("strona bez tekstu zatrzymuje pipeline", async () => {
  await assert.rejects(() => runStep(block, { source: { document: stronaBezTekstu() } }), /bez warstwy tekstowej/);
});

/**
 * Na tym stoi sprawdzenie w przeglądarce (`bezWarstwyTekstowej` w playerze):
 * z takiego pliku nie wychodzi ani jeden znak, więc przeglądarka rozpoznaje go
 * bez powtarzania progu bloku i nie wysyła zdjęcia umowy na serwer po to, żeby
 * usłyszeć „nie umiem tego przeczytać". Gdyby `unpdf` zaczął zwracać stąd
 * cokolwiek, ten test padnie zanim padnie tamto.
 */
test("z takiej strony nie wychodzi ani jeden znak", async () => {
  const ctx = { source: { document: stronaBezTekstu() } };

  await assert.rejects(() => runStep(block, ctx));
  assert.equal(ctx.text.raw.replace(/=== Strona \d+ ===/g, "").replace(/\s/g, ""), "");
});

test("o dokument blok pyta człowieka, o tekst ze skanu nie", () => {
  // Kanał dostarczenia to dziś wyłącznie wgranie — blok pyta o plik sam,
  // więc pipeline bez dokumentu staje na pytaniu, nie na błędzie ułożenia.
  // `document_ocr` składa przeglądarka, więc nie jest wymagane: umowa
  // z warstwą tekstową go nie ma i to nie jest brak danych.
  const [dokument, ocr] = block.form();

  assert.equal(dokument.id, "document");
  assert.equal(dokument.filledBy, undefined);
  assert.equal(ocr.id, "document_ocr");
  assert.equal(ocr.filledBy, "browser");

  assert.deepEqual(block.requires, ["source.document"]);
  assert.deepEqual(block.provides, ["text.raw"]);
});

test("tekst ze skanu bije warstwę tekstową i niesie znaczniki stron", async () => {
  // Gdy przeglądarka przysłała OCR, znaczy że warstwy nie było — blok nie ma
  // czego szukać w PDF-ie i nie wolno mu na tym stanąć.
  const ctx = {
    source: {
      document: stronaBezTekstu(),
      document_ocr: new TextEncoder().encode("=== Strona 1 ===\nUmowa kredytu. RRSO: 12,3%"),
    },
  };
  const { note } = await runStep(block, ctx);

  assert.match(ctx.text.raw, /^=== Strona 1 ===/);
  assert.match(ctx.text.raw, /RRSO/);
  assert.match(note, /skan po OCR w przeglądarce/);
});

test("pusty wynik OCR zatrzymuje sprawę, zamiast udawać pustą umowę", async () => {
  const ctx = {
    source: {
      document: stronaBezTekstu(),
      document_ocr: new TextEncoder().encode("=== Strona 1 ===\n   \n"),
    },
  };

  await assert.rejects(() => runStep(block, ctx), /ani jednego znaku/);
});

// ── warstwa tekstowa z przeglądarki ──────────────────────────────────────

const tekstem = (s) => new TextEncoder().encode(s);
const STRONA_TEKSTU = `=== Strona 1 ===\n${"Umowa pożyczki, RRSO 11,03%. ".repeat(6)}`;

test("warstwa tekstowa z przeglądarki zastępuje odczyt na serwerze", async () => {
  const ctx = {
    source: {
      // Bajty PDF-a i tak lecą do kubełka; tekstu z nich już się nie wyjmuje.
      document: new Uint8Array(8),
      document_text: tekstem(STRONA_TEKSTU),
    },
  };
  const { note } = await runStep(block, ctx);

  assert.match(note, /z przeglądarki/);
  assert.equal(ctx.text.raw, STRONA_TEKSTU);
});

test("serwer stosuje próg także do tekstu z przeglądarki", async () => {
  // Przeglądarka niczego nie rozstrzyga: cienka warstwa to skan i tu zapada
  // ta sama decyzja, co przy odczycie własnym.
  const chudy = { source: { document: new Uint8Array(8), document_text: tekstem("=== Strona 1 ===\nAneks") } };

  await assert.rejects(() => runStep(block, chudy), /bez warstwy tekstowej/);
});

test("OCR skanu bije warstwę tekstową z przeglądarki", async () => {
  // Gdy przeglądarka przysłała OCR, znaczy że warstwy nie było — nawet jeśli
  // przy okazji doleciał jej strzęp.
  const ctx = {
    source: {
      document: new Uint8Array(8),
      document_ocr: tekstem("=== Strona 1 ===\nTreść ze skanu"),
      document_text: tekstem(STRONA_TEKSTU),
    },
  };
  const { note } = await runStep(block, ctx);

  assert.match(note, /skan po OCR/);
  assert.match(ctx.text.raw, /Treść ze skanu/);
});
