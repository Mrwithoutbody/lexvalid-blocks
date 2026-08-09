/**
 * Co pseudonimizacja i guard muszą czytać tak samo: wzorce identyfikatorów
 * i sposób odczytania listy nazwisk. Jeden po nich podstawia, drugi po nich
 * szuka — rozjazd na pierwszym dopisanym wzorcu znaczyłby, że guard przepuszcza
 * to, czego maskowanie nie zdjęło.
 *
 * Wspólne stoi w osobnym pliku, a nie w którymś z klocków: gdy każdy trzyma
 * połowę, importują się nawzajem i żadnego nie da się wziąć bez drugiego.
 *
 * Sumy kontrolne, nie same kształty: jedenaście cyfr obok siebie to w umowie
 * kredytowej równie dobrze numer wewnętrzny banku. Bez sprawdzenia sumy guard
 * zatrzymywałby co drugą umowę.
 */

/** Odpowiedź z formularza → lista nazwisk. Jedno w wierszu albo po przecinku. */
export const splitNames = (odpowiedz) =>
  String(odpowiedz ?? "")
    .split(/[\n,;]/)
    .map((nazwa) => nazwa.trim())
    .filter(Boolean);

/** Suma kontrolna PESEL plus sensowna data — chroni przed przypadkowym ciągiem cyfr. */
function peselOk(pesel) {
  const wagi = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
  const suma = wagi.reduce((total, waga, i) => total + waga * Number(pesel[i]), 0);
  if ((10 - (suma % 10)) % 10 !== Number(pesel[10])) return false;

  const miesiac = Number(pesel.slice(2, 4)) % 20;
  const dzien = Number(pesel.slice(4, 6));
  return miesiac >= 1 && miesiac <= 12 && dzien >= 1 && dzien <= 31;
}

function nipOk(nip) {
  const wagi = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const suma = wagi.reduce((total, waga, i) => total + waga * Number(nip[i]), 0);
  const kontrolna = suma % 11;
  return kontrolna !== 10 && kontrolna === Number(nip[9]);
}

/** mod-97 (ISO 13616) dla NRB traktowanego jak polski IBAN. */
function ibanOk(cyfry26) {
  // przestawienie: cyfry[2..] + "PL" (P=25, L=21) + dwie cyfry kontrolne
  const przestawione = cyfry26.slice(2) + "2521" + cyfry26.slice(0, 2);

  let reszta = 0;
  for (const znak of przestawione) reszta = (reszta * 10 + Number(znak)) % 97;

  return reszta === 1;
}

export const PATTERNS = [
  {
    type: "IBAN/NRB",
    re: /(?:PL)?\d{2}[ ]?(?:\d{4}[ ]?){6}(?!\d)/g,
    ok: (raw) => {
      const cyfry = raw.replace(/ /g, "").replace(/^PL/, "");
      return cyfry.length === 26 && ibanOk(cyfry);
    },
    label: "NR-RACHUNKU",
  },
  { type: "PESEL", re: /(?<!\d)\d{11}(?!\d)/g, ok: peselOk, label: "PESEL" },
  {
    type: "NIP",
    re: /(?<![\d-])\d{3}[- ]?\d{3}[- ]?\d{2}[- ]?\d{2}(?![\d-])/g,
    ok: (raw) => {
      const cyfry = raw.replace(/[- ]/g, "");
      return cyfry.length === 10 && nipOk(cyfry);
    },
    label: "NIP",
  },
  { type: "email", re: /[\w.+-]+@[\w-]+\.[\w.-]{2,}/g, label: "EMAIL" },
  { type: "telefon", re: /(?:\+48[\s-]?)?\d{3}[\s-]\d{3}[\s-]\d{3}(?!\d)/g, label: "TELEFON" },
  { type: "nr dowodu", re: /\b[A-Z]{3}\s?\d{6}\b/g, label: "NR-DOWODU" },
];

/** Znalezione identyfikatory, każdy przycięty — nigdy nie oddajemy pełnej wartości. */
export function scan(text) {
  const hits = [];

  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern.re)) {
      if (!pattern.ok || pattern.ok(match[0])) hits.push({ typ: pattern.type, fragment: mask(match[0]) });
    }
  }

  return hits;
}

const mask = (value) =>
  value.length <= 5 ? `${value[0]}***` : `${value.slice(0, 3)}${"*".repeat(value.length - 5)}${value.slice(-2)}`;
