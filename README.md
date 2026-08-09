# lexvalid-blocks — repozytorium klocków i modeli danych

Osobne repo, jak katalog wtyczek obok WordPressa: host (`lexvalid_v3`) montuje
je submodułem pod `repozytorium/` i nie zawiera żadnego klocka u siebie.

```
blocks/            klocki: <nazwa>/index.mjs + index.test.mjs
blocks/index.mjs   rejestr — nowy klocek to katalog i jedna linia tutaj
models/            modele danych: słownik korzeni, na którym pracują klocki
models/index.mjs   rejestr modeli
```

## Zasada

**Klocek pracuje na modelu danych i tylko na nim.** Deklaruje polem `model`,
do którego słownika należy, a ścieżkami `requires`/`reads`/`provides` — po co
dokładnie sięga i co oddaje. Host egzekwuje obie strony: do `run` wchodzi
wycinek kontekstu (nic spoza deklaracji nie da się przeczytać), z `run` wychodzi
mapa wartości (nic spoza `provides` nie da się zapisać).

Jak wtyczka WordPressa wymaga WordPressa, tak klocek wymaga hosta: importy
`../../../src/*` to kontrakt z nim (model danych: `case-context.mjs`, wspólny
język warunków: `conditions.mjs`). Testy klocków uruchamia host — `npm test`
w jego korzeniu.

## Nowy klocek

1. Przeczytaj model: `models/<id>.json` — każdy korzeń z opisem, kto w niego
   pisze i co znaczy `null`, dowód, `text.safe`.
2. Przeczytaj sekcję „Kontrakt bloku" w `CLAUDE.md` hosta.
3. Katalog `blocks/<nazwa>/` + linia w `blocks/index.mjs`.
4. W hoście: `npm test` i `node src/cli.mjs --check case-types/*.json`.

Silnika czytać nie trzeba — jeśli trzeba było, to jest błąd tego repo.
