/**
 * Klocki dostępne w tej instalacji.
 *
 * Silnik importuje ten jeden plik i dalej nie zna żadnej nazwy bloku z osobna.
 * Lista musi być wypisana, bo `import(\`./${id}/index.mjs\`)` ze zmienną
 * w ścieżce jest nie do zbundlowania — ani Workers, ani żaden inny bundler
 * nie wie z góry, co spakować.
 *
 * Dwie półki, jedna reguła wzrostu:
 *
 *   MECHANIZMY — dokument, kwalifikacja, pseudonimizacja, ekstrakcja,
 *   checklista, pismo. Cała treść prawna, którą operują, stoi w
 *   `case-types/*.json`: nowy rodzaj sprawy składa się z nich bez linijki JS.
 *
 *   ARYTMETYKA DZIEDZINY — credit-cost, skd-deadline. Bisekcja RRSO i krata
 *   dwóch wykładni terminu nie zapiszą się danymi, a kwoty idą do pozwu, więc
 *   liczy je kod pod testami. Prefiks `skd-` jest informacją: w sprawie o najem
 *   ten klocek nie ma czego szukać.
 *
 * Liczba klocków ma rosnąć wyłącznie z drugą półką. Pismo, pozycja checklisty,
 * pytanie kwalifikacji — to cztery linijki JSON-a, nie katalog w `blocks/`.
 *
 * Kolejność jest kolejnością analizy: dokument → czy to ta sprawa → maskowanie
 * → fakty → wyliczenia → naruszenia → pismo.
 *
 * Nazwa z myślnikiem nie jest identyfikatorem JS, więc eksport idzie przez
 * nazwę w cudzysłowie.
 *
 * Nowy klocek: katalog w `blocks/<nazwa>/` i jedna linia tutaj.
 */
// Rejestr WBUDOWANYCH — te jadą z deployem świadomie, bo to rdzeń. Klocki
// wgrywane przez kancelarię wycofane (host: e360a6f) — wracają razem
// z izolatem (Worker Loader), nie wcześniej.
export { default as document } from "./document/index.mjs";
export { default as screening } from "./screening/index.mjs";
export { default as pseudonymization } from "./pseudonymization/index.mjs";
export { default as "fact-extraction" } from "./fact-extraction/index.mjs";
export { default as "credit-cost" } from "./credit-cost/index.mjs";
export { default as "skd-deadline" } from "./skd-deadline/index.mjs";
export { default as "contract-checklist" } from "./contract-checklist/index.mjs";
export { default as letter } from "./letter/index.mjs";
