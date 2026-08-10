import { under } from "../../../src/contract/case-context.mjs";

/**
 * Jedno wywołanie LLM: wyciągnięcie wskazanych pól jako JSON.
 *
 * Model tylko przepisuje to, co widzi w tekście. Żadnych przeliczeń — RRSO
 * i limity liczy deterministyczny kod, bo te kwoty idą do pozwu i biegły je
 * sprawdzi.
 */

/**
 * Nazwy pól → ścieżki, którymi adresuje je reszta pipeline'u.
 *
 * `pola` nazywa klucze w `ctx.facts`, a nie ścieżki, więc kropka w nazwie
 * rozjeżdża dwa odczyty: kontrola ułożenia porównuje ścieżki jako napisy
 * i „facts.oplaty.dodatkowe" zgadza się jej z zadeklarowaną, a przebieg schodzi
 * po kropkach w głąb obiektu i trafia w `undefined`. `--check` przepuszczał taki
 * układ, a pipeline stawał na nim z komunikatem o błędzie ułożenia.
 *
 * Jedno źródło nazw dla deklaracji i dla wywołania — inaczej kontrola siedziałaby
 * w `provides`, a `run` i tak zapłaciłby za wywołanie modelu.
 */
export const fields = (step) =>
  (step.pola ?? []).map((entry) => {
    // Sama nazwa wystarczy tam, gdzie mówi wszystko (`data_umowy`). Postanowienie
    // umowne nazwy nie ma i bez zdania, czego szukać, model oddaje `null` na
    // umowie, która je zawiera — a checklista czyta to jako brak naruszenia.
    const field = typeof entry === "string" ? { id: entry } : (entry ?? {});
    const id = String(field.id ?? "");

    if (!id) throw new Error("pole ekstrakcji bez nazwy");
    if (id.includes(".")) {
      throw new Error(`kropka w nazwie pola „${id}" — ekstrakcja nie tworzy zagnieżdżeń`);
    }

    // `wymagane` mówi, że bez tej wartości dalsze kroki nie mają czego liczyć,
    // więc brak w dokumencie ma być PYTANIEM do człowieka, nie awarią. Które
    // pola są takie, zależy od rodzaju sprawy, nie od mechanizmu — stąd dane.
    return { id, opis: field.opis ?? null, wymagane: field.wymagane === true, typ: field.typ ?? "kwota" };
  });

export const fieldNames = (step) => fields(step).map((field) => field.id);

/** Porównanie cytatu z tekstem: białe znaki do jednej spacji, reszta znak w znak. */
const compact = (tekst) => String(tekst).replace(/\s+/g, " ").trim();

/**
 * Schemat strict wymusza kształt odpowiedzi: każde pole obecne, każde jako
 * `{value, cytat, strona}`. Przekręcona nazwa klucza i goła wartość przestają
 * być możliwe — to była połowa chwiejności ekstrakcji, którą wcześniej łatały
 * kontrole po fakcie. Druga połowa (zmyślony cytat) zostaje przy `factsFrom`,
 * bo schemat wymusza kształt, nie prawdę.
 */
const FIELD_SHAPE = {
  type: "object",
  additionalProperties: false,
  required: ["value", "cytat", "strona"],
  properties: {
    value: { type: ["number", "string", "null"] },
    cytat: { type: ["string", "null"] },
    strona: { type: ["integer", "null"] },
  },
};

export const responseSchema = (wanted) => ({
  type: "object",
  additionalProperties: false,
  required: wanted,
  properties: Object.fromEntries(wanted.map((field) => [field, FIELD_SHAPE])),
});

/**
 * Odpowiedź modelu → fakty i dowody.
 *
 * Model odpowiada obiektem `{value, cytat, strona}` na klucz, ale bywa, że
 * odda gołą wartość — przyjmujemy obie formy, bo ciche odrzucenie dobrze
 * odczytanej wartości robi z niej zarzut „braku w umowie".
 *
 * Cytat jest dowodem, więc jest SPRAWDZANY: fragment, którego nie ma w tekście
 * wysłanym do modelu, to konfabulacja i nie wchodzi do sprawy. Wartość zostaje
 * — o wartości mówi checklista i przeliczenia — ale dowód przy niej będzie
 * pusty, a pusty dowód sam mówi „zweryfikuj ręcznie". Zmyślony mówiłby
 * „sprawdzone", i to jest dokładnie ta różnica, która odróżnia raport od slopu.
 */
export function factsFrom(raw, wanted, text) {
  const facts = {};
  const evidence = {};
  const fabricated = [];
  const haystack = compact(text);

  for (const field of wanted) {
    const answer = raw[field];
    const wrapped = answer !== null && typeof answer === "object" && !Array.isArray(answer);

    facts[field] = (wrapped ? answer.value : answer) ?? null;
    evidence[field] = null;

    const cytat = wrapped && facts[field] !== null ? answer.cytat : null;
    if (typeof cytat === "string" && cytat.trim()) {
      if (haystack.includes(compact(cytat))) {
        evidence[field] = { cytat, strona: typeof answer.strona === "number" ? answer.strona : null };
      } else {
        fabricated.push(field);
      }
    }
  }

  return { facts, evidence, fabricated };
}

export default {
  model: "analiza-dokumentu",
  // Podnieś, gdy zmienia się WYNIK tego klocka — sprawy policzone starszą
  // wersją same zgłoszą się do przeliczenia (`src/engine/versions.mjs`).
  wersja: 1,
  name: "Ekstrakcja faktów",
  // Koszt wywołania i wybór modelu to sprawa dewelopera — nie stoi na karcie.
  description: "Wyciąga z umowy wskazane dane. Przepisuje to, co w niej stoi — nic nie liczy.",

  // Lupa: blok szuka w tekście wskazanych faktów.
  icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  requires: ["text.safe"],

  // Odpowiedzi na dopytanie o pola, których w dokumencie nie było. Odczyt
  // miękki: przy pierwszym przebiegu jeszcze ich nie ma i to nie jest błąd.
  reads: (step) => fields(step).filter((f) => f.wymagane).map((f) => `answers.${f.id}`),

  /**
   * Pola wymagane stoją w formularzu, ale z `naZadanie` — czyli nikt o nie nie
   * pyta z góry. Najpierw próbuje ich odczytać model; dopiero gdy w dokumencie
   * ich nie ma, blok prosi o nie wprost (`error.pyta`).
   *
   * Deklaracja musi tu być mimo to: silnik wpuszcza do `answers.` wyłącznie
   * odpowiedzi na pola, które jakiś blok zapowiedział w `form` — bez tego
   * wpisana ręcznie kwota nie miałaby jak wrócić do przebiegu.
   */
  form: (step) =>
    fields(step)
      .filter((field) => field.wymagane)
      .map((field) => ({
        id: field.id,
        label: field.opis ? `${field.id.replace(/_/g, " ")} — ${field.opis}` : field.id.replace(/_/g, " "),
        type: field.typ,
        naZadanie: true,
      })),

  // Wydaje dokładnie te pola, o które kazano zapytać — dzięki temu checklista
  // może wymagać `facts.kaucja`, a literówka w jej warunku zatrzyma pipeline
  // zamiast wyglądać jak brak tej informacji w umowie.
  //
  // Do każdego faktu dochodzi dowód: `evidence.<pole>` to `{cytat, strona}`
  // albo null. Osobny korzeń, nie pole w fakcie — dzięki temu `facts.kaucja`
  // w warunku checklisty pozostaje wartością, a nie obiektem do rozpakowania.
  provides: (step) => fieldNames(step).flatMap((field) => [`facts.${field}`, `evidence.${field}`]),
  report: ["facts", "evidence"],

  // `limit_znakow` zostaje poza listą: domyślnie idzie cały tekst, a ucinać
  // ma prawo wyłącznie świadoma decyzja w JSON-ie kroku — nie kontrolka,
  // którą ktoś przypadkiem wypełni.
  /**
   * Ten krok nie ma prawa policzyć się dwa razy na tej samej treści: kosztuje,
   * a przy okazji ta sama umowa potrafi oddać nieco inne fakty i tym samym inny
   * zarzut. Silnik nie wie, co jest drogie — klucz podaje blok, z tego, co
   * naprawdę czyta: treść po pseudonimizacji, lista pól i model.
   *
   * Sam tekst zamiast jego skrótu, bo `memo` i tak leży w kubełku obok umowy,
   * a licząc skrót trzeba by wybrać funkcję i pilnować, żeby nie stała się
   * cichym identyfikatorem dokumentu.
   */
  // ponytail: odpowiedzi wchodzą do klucza, więc wpisanie brakującej wartości
  // ręcznie kosztuje JEDNO dodatkowe wywołanie modelu (klucz się zmienia,
  // a poprzedni przebieg i tak nie zdążył zapisać memo, bo przerwał na
  // pytaniu). Upgrade: rozdzielić klucz modelu od klucza scalenia, gdy
  // dopytania staną się częste.
  memoKey: (ctx, step) =>
    JSON.stringify([
      step.model ?? null,
      fields(step),
      (ctx.text?.safe ?? "").length,
      ctx.text?.safe,
      Object.fromEntries(fields(step).filter((f) => f.wymagane).map((f) => [f.id, ctx.answers?.[f.id] ?? null])),
    ]),

  /**
   * Wkład do interfejsu: zaznaczenie cytatu-dowodu przy każdym odczytanym
   * fakcie. Ranga 1 — dowód ustępuje zarzutowi, gdy cytaty się nakładają.
   */
  widoki: (ctx, step) =>
    fieldNames(step).some((pole) => ctx.evidence?.[pole])
      ? [
          {
            widzet: "zaznaczenia",
            zaznaczenia: fieldNames(step)
              .filter((pole) => ctx.evidence?.[pole]?.cytat)
              .map((pole) => ({
                cytat: ctx.evidence[pole].cytat,
                rodzaj: "info",
                ranga: 1,
                id: `mark-${pole}`,
                etykieta: `${pole.replace(/_/g, " ")}: ${ctx.facts?.[pole] ?? "—"}`,
                legenda: "odczytany fakt",
              })),
          },
        ]
      : [],

  settings: [
    {
      id: "pola",
      label: "Pola do wyciągnięcia z dokumentu",
      type: "wiersze",
      pola: [
        { id: "id", label: "Nazwa pola", type: "tekst" },
        { id: "opis", label: "Czego szukać w umowie", type: "tekst" },
      ],
    },
    { id: "model", label: "Model", type: "tekst" },
  ],

  async run(ctx, step) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("brak OPENAI_API_KEY");

    const model = step.model ?? process.env.MODEL ?? "gpt-4.1-mini";
    // Rzuca przed wywołaniem modelu, nie po — nazwa nie do zaadresowania i tak
    // zatrzyma pipeline krok dalej, a wtedy jest już zapłacone.
    const asked = fields(step);
    const wanted = asked.map((field) => field.id);
    // Domyślnie CAŁY tekst. Ucięcie „bo szukane dane są na pierwszych stronach"
    // kosztowało zarzut z art. 30 postawiony umowie, która klauzulę odstąpienia
    // miała — tyle że za granicą cięcia. Limit zostaje jako świadoma decyzja
    // w konfiguracji kroku, nie jako cichy domysł bloku.
    const LIMIT = step.limit_znakow ?? Infinity;

    // Pole z opisem idzie osobnym wierszem, gołe nazwy jednym ciągiem — inaczej
    // trzynaście linijek „bank —" zagłusza te trzy, które naprawdę coś mówią.
    const described = asked.filter((field) => field.opis);
    const bare = wanted.filter((id) => !described.some((field) => field.id === id));

    const instructions = [
      bare.length && `Klucze bez dodatkowych wskazówek: ${bare.join(", ")}.`,
      ...described.map((field) => `${field.id}: ${field.opis}`),
    ].filter(Boolean);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        // Strict: model NIE MOŻE oddać innego kształtu niż pola z kroku.
        response_format: {
          type: "json_schema",
          json_schema: { name: "facts", strict: true, schema: responseSchema(wanted) },
        },
        messages: [
          {
            role: "system",
            content:
              `Czytasz polski dokument umowny wyodrębniony z PDF — może być po pseudonimizacji ` +
              `(placeholdery typu [OSOBA-1]), a znaczniki "=== Strona N ===" wskazują numery stron.\n` +
              `${instructions.join("\n")}\n` +
              // Cytat to dowód dla sądu, nie ozdoba — i jest sprawdzany co do
              // znaku, więc parafraza przepada razem ze swoją wiarygodnością.
              `"cytat" to dosłowny fragment tekstu, z którego odczytano wartość — przepisz go znak ` +
              `w znak, będzie porównany z tekstem. "strona" to numer ze znacznika przy tym fragmencie.\n` +
              `Kwoty jako liczby, daty jako RRRR-MM-DD. Nazwy własne przepisz dosłownie. ` +
              // Bez tego model dolicza datę spłaty do daty zawarcia i oddaje ją tak
              // samo pewnie jak przepisaną — a stąd biegnie termin zawity z art. 45
              // ust. 5 UKK. Wyliczone przez kod ma zastrzeżenie w raporcie,
              // wyliczone przez model wygląda jak wyczytane z umowy.
              `Niczego nie wyliczaj — ani dat, ani kwot, ani sum. Przepisujesz tylko to, co stoi ` +
              `w tekście. Czego nie ma w tekście — value: null, cytat: null. Nie zgaduj.`,
          },
          { role: "user", content: ctx.text.safe.slice(0, LIMIT) },
        ],
      }),
    });

    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${await response.text()}`);

    const body = await response.json();
    const raw = JSON.parse(body.choices[0].message.content);

    // Model potrafi przekręcić nazwę klucza (oplaty_ → oplata_). Bez tej kontroli
    // dobrze odczytana wartość wygląda dalej jak brak informacji w umowie,
    // co checklista zgłosiłaby jako zarzut. Bierzemy tylko to, o co pytaliśmy.
    const sent = ctx.text.safe.slice(0, LIMIT);
    const { facts, evidence, fabricated } = factsFrom(raw, wanted, sent);

    /**
     * Pole wymagane, którego w dokumencie nie ma — umowa odsyła kwotę raty do
     * załączonego harmonogramu, a ten nie jest częścią akt. Odpowiedź człowieka
     * podstawiamy w miejsce braku i mówimy o tym wprost: dowód zostaje pusty
     * ze wskazaniem źródła, więc raport nie udaje, że to odczyt z umowy.
     *
     * Ekstrakcja pozostaje JEDYNYM piszącym w `facts.` — człowiek odpowiada
     * pod `answers.`, a to ten blok rozstrzyga, co z tego wynika.
     */
    const wpisane = [];
    const doPytania = [];

    for (const field of asked.filter((f) => f.wymagane)) {
      if (facts[field.id] !== null && facts[field.id] !== undefined) continue;

      const odpowiedz = ctx.answers?.[field.id];
      if (odpowiedz === undefined || odpowiedz === null || odpowiedz === "") {
        doPytania.push(field);
        continue;
      }

      facts[field.id] = odpowiedz;
      evidence[field.id] = { cytat: null, strona: null, zrodlo: "wpisane ręcznie" };
      wpisane.push(field.id);
    }

    if (doPytania.length) {
      const brak = new Error(
        `dokument nie zawiera: ${doPytania.map((f) => f.id.replace(/_/g, " ")).join(", ")} — wpisz ręcznie`,
      );
      // Silnik zamieni to na pytanie do człowieka, nie na awarię.
      brak.pyta = doPytania.map((field) => ({
        id: field.id,
        label: field.opis ? `${field.id.replace(/_/g, " ")} — ${field.opis}` : field.id.replace(/_/g, " "),
        type: field.typ,
      }));
      // To, co model zdążył odczytać, ma zostać w kontekście i w raporcie.
      brak.values = { ...under("facts", facts), ...under("evidence", evidence) };
      throw brak;
    }

    const unexpected = Object.keys(raw).filter((k) => !wanted.includes(k));
    const cited = Object.values(evidence).filter(Boolean).length;

    const warnings = [
      // Bez tego ucięta umowa wygląda jak umowa bez tych informacji, a checklista
      // robi z niej zarzut z art. 30 — nie wolno tego przemilczeć w śladzie.
      ctx.text.safe.length > LIMIT && `tekst ucięty do ${LIMIT} z ${ctx.text.safe.length} znaków`,
      unexpected.length && `model zmyślił klucze: ${unexpected.join(", ")}`,
      // Zmyślony cytat wygląda jak dowód — jego odrzucenie musi być widoczne,
      // bo wartość została i teraz stoi bez pokrycia.
      fabricated.length && `cytaty spoza tekstu odrzucone: ${fabricated.join(", ")}`,
      // Wartość wpisana ręcznie nie ma cytatu w umowie, więc ślad musi o niej
      // powiedzieć — inaczej „12/14 faktów z cytatem" czyta się jak komplet.
      wpisane.length && `wpisane ręcznie: ${wpisane.join(", ")}`,
    ].filter(Boolean);

    const usage = `${body.usage.prompt_tokens} in / ${body.usage.completion_tokens} out`;

    return {
      note: [`${model}, ${usage}`, `${cited}/${wanted.length} faktów z cytatem`, ...warnings].join(", "),
      // Fakt i jego dowód rozchodzą się na dwa korzenie, ale zawsze parą: kwota
      // bez cytatu ma zostać kwotą z jawnie pustym dowodem, nie kwotą bez pola.
      values: { ...under("facts", facts), ...under("evidence", evidence) },
    };
  },
};
