import { extractText, getDocumentProxy } from "unpdf";

/**
 * Dokument sprawy: człowiek wgrywa PDF, blok wyjmuje warstwę tekstową.
 *
 * `unpdf` to build pdf.js bez zależności od systemu — ten sam kod czyta
 * dokument w Workerze, w node i w przeglądarce. Workers nie uruchamiają
 * procesów, a kancelaria nie doinstalowuje pakietów.
 *
 * Skan bez warstwy tekstowej jest rozpoznawany W PRZEGLĄDARCE, zanim cokolwiek
 * ruszy na serwer, i wchodzi tu jako `source.document_ocr`. Ten podział nie jest
 * wygodą: skan to obraz z nazwiskiem i PESEL-em, a pseudonimizacja działa na
 * tekście, więc obraz wysłany do modelu poszedłby surowy. OCR po stronie modelu
 * jest wykluczony, nie niewygodny — dlatego rozpoznanie kończy się na urządzeniu
 * kancelarii, a dalej jedzie sam tekst, który przechodzi pseudonimizację jak
 * każdy inny.
 *
 * Gdy tekstu ze skanu nie ma, blok mówi to wprost. Ciche oddanie pustego tekstu
 * skończyłoby się checklistą pełną zarzutów z art. 30 postawionych umowie,
 * której nikt nie przeczytał.
 *
 * ponytail: kanał dostarczenia (mail, e-Doręczenia, API) będzie osobnym klockiem
 * OBOK tego — dziś istnieje jeden, więc stoi razem z odczytem. Rozdział wraca
 * z drugim kanałem, nie wcześniej.
 */
const MIN_CHARS_PER_PAGE = 80;

/**
 * Znacznik strony przy treści: z niego ekstrakcja podaje stronę cytatu, a bez
 * strony dowodu nie da się odszukać w umowie na biurku. Ten sam kształt składa
 * przeglądarka — i przy OCR-ze, i przy warstwie tekstowej.
 */
const STRONA = /=== Strona \d+ ===/g;

/** Odczyt warstwy tekstowej z bajtów — ścieżka dla CLI i testów. */
async function czytajPdf(bytes) {
  // pdf.js odłącza przekazany bufor, więc pracujemy na kopii.
  const pdf = await getDocumentProxy(new Uint8Array(bytes).slice());
  const { text } = await extractText(pdf, { mergePages: false });

  return text.map((page, i) => `=== Strona ${i + 1} ===\n${page}`).join("\n\n");
}

export default {
  model: "analiza-dokumentu",
  name: "Dokument sprawy",
  description:
    "Człowiek wgrywa PDF, blok wyjmuje jego warstwę tekstową. Zdjęcie albo skan bez tekstu wymaga OCR-u, którego tu nie ma.",

  // Ramka skanera z wierszami tekstu w środku.
  icon: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8h8"/><path d="M7 12h10"/><path d="M7 16h6"/>',

  // Bajty wnosi pole formularza (`source.document` rejestruje samo pole, bo to
  // ono je wypełnia). Treść wychodzi jako `text.raw`: „raw" znaczy przed
  // pseudonimizacją i tylko blok obok ma prawo zrobić z tego `text.safe`.
  // `document_ocr` NIE jest wymagane: umowa z warstwą tekstową go nie ma i to
  // nie jest brak danych. Blok sięga po nie miękko, jak checklista po dowody.
  requires: ["source.document"],
  reads: ["source.document_ocr", "source.document_text"],
  provides: ["text.raw"],
  // Bez `report`: treść umowy to materiał analizy, nie jej wynik.

  form: () => [
    { id: "document", label: "Dokument PDF", type: "plik" },
    // `wypelnia` mówi interfejsowi, że o te pola nie pyta się człowieka —
    // składa je przeglądarka. Deklaracja stoi tutaj, bo to blok wie, co
    // konsumuje; player nie zna nazwy żadnego pola z osobna.
    {
      id: "document_ocr",
      label: "Tekst rozpoznany ze skanu",
      type: "plik",
      wypelnia: "przegladarka",
    },
    {
      id: "document_text",
      label: "Warstwa tekstowa odczytana w przeglądarce",
      type: "plik",
      wypelnia: "przegladarka",
    },
  ],

  async run(ctx) {
    const kB = Math.round(ctx.source.document.byteLength / 1024);

    // Tekst ze skanu bije warstwę tekstową: gdy przeglądarka go przysłała,
    // znaczy że warstwy nie było.
    if (ctx.source.document_ocr) {
      const raw = new TextDecoder().decode(ctx.source.document_ocr);
      const contentChars = raw.replace(STRONA, "").replace(/\s/g, "").length;

      if (!contentChars) throw new Error("OCR skanu nie zwrócił ani jednego znaku");

      return {
        note: `${kB} kB, skan po OCR w przeglądarce, ${contentChars} znaków`,
        values: { "text.raw": raw },
      };
    }

    // Warstwa tekstowa odczytana w przeglądarce — ta sama robota, której nie ma
    // po co robić dwa razy: przeglądarka i tak otwiera PDF-a, żeby sprawdzić,
    // czy nie jest skanem. Serwer nie ufa jej za to na słowo: próg poniżej
    // rozstrzyga tak samo, jak przy odczycie własnym, a oryginał leży w kubełku,
    // więc treść zawsze da się odtworzyć i porównać.
    const wPrzegladarce = ctx.source.document_text
      ? new TextDecoder().decode(ctx.source.document_text)
      : null;

    // pdf.js odłącza przekazany bufor, więc pracujemy na kopii. Ta ścieżka
    // zostaje dla CLI i testów — tam przeglądarki nie ma.
    const odczytane = wPrzegladarce ?? (await czytajPdf(ctx.source.document));

    // Strony liczymy ze znaczników, bo przy tekście z przeglądarki to jedyne,
    // co je niesie — a próg jest na stronę.
    const totalPages = Math.max(1, odczytane.split(STRONA).length - 1);

    // Próg liczy się z samej treści, bez znaczników — inaczej znaczniki
    // podbijałyby licznik i skan wyglądałby na dokument z tekstem.
    const contentChars = odczytane.replace(STRONA, "").replace(/\s/g, "").length;

    const values = { "text.raw": odczytane };

    if (contentChars < MIN_CHARS_PER_PAGE * totalPages) {
      // Odczytana warstwa idzie razem z błędem: za mało jej na analizę, ale
      // to ona pokazuje, dlaczego ten PDF wymaga OCR-u.
      const scan = new Error(`skan bez warstwy tekstowej (${totalPages} str.) — wymaga OCR-u`);
      scan.values = values;
      throw scan;
    }

    const skad = wPrzegladarce ? " z przeglądarki" : "";
    return { note: `${kB} kB, ${totalPages} str., ${contentChars} znaków warstwy tekstowej${skad}`, values };
  },
};
