/**
 * Modele danych dostępne w tej instalacji.
 *
 * Model nazywa korzenie kontekstu i mówi, kto w każdy z nich pisze. Blok
 * deklaruje polem `model`, na którym słowniku pracuje — stąd wiadomo, że pasuje
 * do pipeline'u, zanim ktokolwiek wgra do niego dokument.
 *
 * Lista jest wypisana z tego samego powodu, co w `blocks/` i `case-types/`:
 * Workers nie mają katalogu do przejrzenia, a klucz z żądania ma być kluczem
 * w mapie, nie ścieżką.
 *
 * Nowy model: plik JSON obok i jedna linia tutaj. Sam plik nie wystarczy, bo
 * na Cloudflare i tak potrzebny jest deploy.
 */
import analizaDokumentu from "./analiza-dokumentu.json" with { type: "json" };

// ponytail: modele tylko wbudowane — kancelaria nie doda własnego modelu bez
// deployu. Upgrade: tabela tenant_models przy pierwszym cudzym modelu.
export default {
  "analiza-dokumentu": analizaDokumentu,
};
