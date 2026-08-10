import { under } from "../../../src/contract/case-context.mjs";
import { holds } from "../../../src/contract/conditions.mjs";
import { plural } from "../../../src/contract/plural.mjs";

/**
 * Kwalifikacja — bramka przed płatną częścią pipeline'u, zero AI.
 *
 * Dwa sita w jednym kroku, oba z konfiguracji:
 *   `slowa_kluczowe`  czy dokument w ogóle wygląda na ten rodzaj sprawy —
 *                     umowa najmu wrzucona do pipeline'u kredytowego skończyłaby
 *                     się checklistą zarzutów postawionych dokumentowi, którego
 *                     nikt pod tym kątem nie czytał;
 *   `pytania`         czy sprawa się kwalifikuje — pytania do człowieka
 *                     z warunkami odrzucenia.
 *
 * Rodzaj sprawy używa jednego sita, drugiego albo obu — to konfiguracja kroku,
 * nie wybór klocka. Stoi za dokumentem, bo pytanie zadane komuś, kto ma umowę
 * przed sobą, jest pytaniem o odczytanie, nie o pamięć — i przed modelem, bo to
 * granica, na której odrzucenie jeszcze nic nie kosztuje.
 *
 * Próg słów kluczowych jest ułamkiem trafionych, nie ich liczbą — inaczej
 * dopisanie synonimu do listy rozluźniałoby kontrolę.
 */

/**
 * Porównujemy bez ogonków, bo skan przepuszczony przez OCR zwraca „calkowita
 * kwota do zaplaty" i dokument odpadałby na własnej treści. „ł" nie rozkłada się
 * w NFD — ma własny punkt kodowy — więc idzie osobno.
 */
const bezOgonkow = (tekst) =>
  tekst
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase();

const questions = (step) => step.pytania ?? [];
const keywords = (step) => step.slowa_kluczowe ?? [];

// Blokada porównuje odpowiedź z progiem, więc operatory obecności nie mają tu
// czego sprawdzać — pole bez odpowiedzi zatrzymuje pipeline krok wcześniej.
const BLOKADA_OPS = ["<", ">", "="];

export default {
  model: "analiza-dokumentu",
  name: "Kwalifikacja",
  description:
    "Sprawdza, czy dokument pasuje do tego rodzaju sprawy i czy odpowiedzi ją kwalifikują. Umowa jest już na ekranie — odpowiedzi przepisz z niej.",

  // Lejek: blok odsiewa zgłoszenia, zanim wejdą do płatnej części pipeline'u.
  icon: '<path d="M3 6h18M7 12h10M10 18h4"/>',

  // Wymaga tego, co sprawdza: treści przy słowach kluczowych, odpowiedzi przy
  // pytaniach — a pyta o to, co ma w konfiguracji.
  requires: (step) => [
    ...(keywords(step).length ? ["text.raw"] : []),
    ...questions(step).map((q) => `answers.${q.id}`),
  ],
  provides: (step) => [
    ...(keywords(step).length
      ? ["classification.dopasowanie", "classification.trafione", "classification.brakujace"]
      : []),
    ...(questions(step).length ? ["qualification.pytania"] : []),
  ],
  // Wynik mieści się w jednym zdaniu śladu — raport by go tylko powtórzył.

  /** Czego blok potrzebuje od człowieka. Kreator buduje z tego formularz. */
  form: (step) => questions(step).map((q) => ({ id: q.id, label: q.pytanie, type: q.typ })),

  settings: [
    { id: "slowa_kluczowe", label: "Słowa kluczowe dokumentu", type: "lista" },
    { id: "prog", label: "Próg dopasowania (ułamek trafionych słów)", type: "liczba" },
    {
      id: "pytania",
      label: "Pytania",
      type: "wiersze",
      pola: [
        { id: "id", label: "Klucz odpowiedzi", type: "tekst" },
        { id: "pytanie", label: "Pytanie", type: "tekst" },
        { id: "typ", label: "Typ pola", type: "wybor", opcje: ["tak-nie", "data", "kwota", "tekst"] },
        { id: "blokuj_gdy", label: "Odrzuć gdy", type: "blokada", operatory: BLOKADA_OPS },
        { id: "powod", label: "Powód odrzucenia", type: "tekst" },
      ],
    },
  ],

  async run(ctx, step) {
    const slowa = keywords(step);
    const pytania = questions(step);

    if (!slowa.length && !pytania.length) {
      throw new Error("krok bez `slowa_kluczowe` i bez `pytania` — nie ma czego sprawdzić");
    }

    const notes = [];
    const values = {};

    if (slowa.length) {
      const tekst = bezOgonkow(ctx.text.raw);
      const trafione = slowa.filter((slowo) => tekst.includes(bezOgonkow(slowo)));
      const dopasowanie = trafione.length / slowa.length;
      const prog = step.prog ?? 0.5;

      Object.assign(
        values,
        under("classification", {
          dopasowanie: Math.round(dopasowanie * 100) / 100,
          trafione,
          brakujace: slowa.filter((slowo) => !trafione.includes(slowo)),
        }),
      );

      if (dopasowanie < prog) {
        // Dopasowanie jedzie z błędem: „to nie ta sprawa" bez listy słów, których
        // zabrakło, nie daje się sprawdzić bez ponownego czytania umowy.
        const obcy = new Error(
          `dokument nie wygląda na ten rodzaj sprawy — trafiło ${trafione.length} z ${slowa.length} ` +
            `słów kluczowych (próg ${Math.round(prog * 100)}%)`,
        );
        obcy.values = values;
        throw obcy;
      }

      notes.push(`${trafione.length}/${slowa.length} słów kluczowych (${Math.round(dopasowanie * 100)}%)`);
    }

    if (pytania.length) {
      const rejections = [];

      for (const question of pytania) {
        const [operator, threshold] = question.blokuj_gdy ?? [];

        // Literówka w operatorze zostawiała pytanie bez porównania: warunek
        // nigdy nie zapalał i sprawa szła dalej po cichu, tak samo jak przy
        // poprawnej odpowiedzi. A to bramka stojąca przed dokumentem klienta.
        if (!BLOKADA_OPS.includes(operator)) {
          throw new Error(`nieznany operator w kwalifikacji: "${operator}" (pytanie ${question.id})`);
        }

        if (holds([`answers.${question.id}`, operator, threshold], ctx)) rejections.push(question.powod);
      }

      // Odrzucenie sprawy to werdykt, nie awaria. Powody jadą osobną listą, żeby
      // interfejs nie musiał ich wyłuskiwać z tekstu błędu ani malować werdyktu
      // czerwienią zarezerwowaną dla „nie zadziałało".
      if (rejections.length) {
        const rejected = new Error(rejections.join("; "));
        rejected.rejections = rejections;
        rejected.values = values;
        throw rejected;
      }

      // Blok obiecuje `qualification`, więc musi to oddać — inaczej krok, który
      // by na tym stanął, nie doczekałby się niczego.
      Object.assign(values, under("qualification", { pytania: pytania.length }));

      notes.push(`${plural(pytania.length, "pytanie", "pytania", "pytań")} — sprawa kwalifikuje się`);
    }

    return { note: notes.join("; "), values };
  },
};
