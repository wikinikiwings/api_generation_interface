# ITERATION 4C — image perf, caching & date-range filtering

> Закрывает итерация 4b (POST в `/api/history` из generate-form + фикс модалки через адаптер). Юзер подтвердил что всё работает.
>
> 4c — перформанс-итерация: трёхуровневые разрешения, blob-кеш, пагинация, дебаунс, onError-fallback'и + портирование date-range-фильтра из viewcomfy-claude (эталон лежит на уровень выше по пути `E:\my_stable\viewcomfy\viewcomfy-claude\`).

## Что УЖЕ есть на момент старта 4c

- ✅ **Бэкенд трёх разрешений.** `app/api/history/route.ts` POST уже генерирует `thumb_<uuid>.jpg` (280px, JPEG q70) + `mid_<uuid>.png` (1200px, PNG q85) через `sharp`, каждое в отдельном try/catch, с фильтром `image/* && !image/vnd.adobe.photoshop`. Соответствует спеке пункт 1 — **не трогать.**
- ✅ **GET принимает диапазон дат.** `/api/history?username=X&startDate=&endDate=&limit=&offset=` — `getGenerations()` в `lib/history-db.ts` уже это умеет, `startDate`/`endDate` прокидываются. Серверная часть фильтрации готова, нужен только UI.
- ✅ **Endpoint `/api/history/image/[filename]`** умеет отдавать любой variant по имени (`thumb_*`, `mid_*`, оригинал) с `Cache-Control: immutable`.
- ✅ **Сайдбар частично использует thumb:** `imgUrl(filepath, "thumb")` в `ServerEntryCard` + `loading="lazy"`. Этот кусок спеки частично закрыт.
- ✅ **`<ImageDialog>` через адаптер** `serverGenToHistoryEntry()` — фикс регрессии из 4b.

## Чего НЕТ (gap-лист, цели 4c)

1. ❌ **mid-версия в диалоге.** `ImageDialog` получает полноразмерный оригинал, не mid.
2. ❌ **onError fallback thumb→оригинал** для старых записей без thumb-файлов (у `max_k`/`wikinik` могут быть).
3. ❌ **onError fallback mid→оригинал** в диалоге.
4. ❌ **`lib/image-cache.ts`** (blob-кеш + preload) — главный UX-буст из спеки.
5. ❌ **Пагинация 20+loadMore.** Сейчас `limit=100` одним запросом.
6. ❌ **Дебаунс `triggerHistoryRefresh` ~1.5s.**
7. ❌ **Date-range фильтр** (UI). Бэкенд готов, фронта нет.
8. ❌ **Drag-n-drop из истории в дропзону** (`application/x-viewcomfy-media`).

## Эталоны в viewcomfy-claude (читать перед работой)

- `E:\my_stable\viewcomfy\viewcomfy-claude\hooks\use-local-history.tsx` — SWR-хук с pagination, debounced `refreshAllHistory()`, `PAGE_SIZE = 20`, `REFRESH_DEBOUNCE_MS = 1500`. У нас НЕТ `swr` в deps — либо ставим, либо портируем логику на голый `useState` + `useEffect` (рекомендую второе, чтобы не тащить зависимость ради одного хука).
- `E:\my_stable\viewcomfy\viewcomfy-claude\components\history-sidebar.tsx` — использование `DatePickerWithRange` + `DateRange` из `react-day-picker`, `subDays(today, 7)` как дефолт.
- `E:\my_stable\viewcomfy\viewcomfy-claude\components\ui\date-picker-with-range.tsx` — обёртка Popover + Calendar. Зависит от `react-day-picker`, `date-fns`, `@radix-ui/react-popover`, shadcn `Calendar`. Ни одной из этих зависимостей у нас сейчас нет — см. план ниже.

## План работ (порядок от дешёвого к дорогому)

### Шаг 1. mid в диалоге + onError fallback'и (дёшево, большой эффект)

**`components/history-sidebar.tsx`:**
- В `ServerEntryCard` добавить `midSrc = imgUrl(firstImage.filepath, "mid")`.
- В `serverGenToHistoryEntry()` передавать `midSrc` как новый параметр и класть в отдельное поле адаптера — НО `ImageDialog` принимает `HistoryEntry` с одним `outputUrl`, так что проще: передать `midSrc` вместо `fullSrc` в адаптер, а `fullSrc` (оригинал) использовать только для Download. Значит нужно расширить адаптер: вернуть объект с `outputUrl=midSrc` + отдельное поле `_originalUrl` (не в `HistoryEntry`, передавать в ImageDialog как новый prop).
- **Либо** (проще): расширить `ImageDialog` опциональным prop'ом `downloadUrl?: string`. Если задан — Download использует его, `<img>` использует `entry.outputUrl` (mid). Минимальная правка `image-dialog.tsx`.
- На `<img>` внутри `DialogContent` добавить `onError` — если mid упал, переключить `src` на оригинал (через `useState`-флаг `midFailed`).
- На миниатюре в `ServerEntryCard` добавить `onError` — если thumb упал, переключить на оригинал.

### Шаг 2. `lib/image-cache.ts` + preload (главный UX-буст)

Создать `lib/image-cache.ts`:
```ts
const blobCache = new Map<string, string>();      // url → blob://
const inflight = new Map<string, Promise<string>>(); // url → promise (dedup)

export async function preloadWithFallback(
  midUrl: string,
  originalUrl: string
): Promise<string> { /* try mid, fallback to original, cache by the URL that won */ }

export function getCachedUrl(url: string): string | null { /* Map.get */ }
```
- Map на модульном уровне (переживает HMR в dev через `globalThis._imageCache ||=`).
- Дедупликация: если запрос уже in-flight — возвращать существующий промис.
- При fallback на original — кешируем под ключом `midUrl` (чтобы повторно не ломились в mid).

В `ServerEntryCard` добавить `useEffect(() => { void preloadWithFallback(midSrc, fullSrc).then(...)  }, [])` — фоновый preload сразу при монтировании. Результат класть в локальный state `dialogSrc`, который передаётся в адаптер вместо `midSrc`. Если preload не успел — адаптер отдаст обычный `midSrc` и диалог сам догрузит по сети (fallback поведения).

### Шаг 3. Вынести логику в `hooks/use-history.ts` + пагинация

Пока всё живёт в `history-sidebar.tsx` — переносим в хук `hooks/use-history.ts` по аналогии с viewcomfy-эталоном, НО без `swr` (у нас его нет в `package.json`, не хотим тащить). Голый `useState` + `useEffect` + `useCallback`:

```ts
export function useHistory(params: {
  username: string | null;
  startDate?: Date;
  endDate?: Date;
}) {
  const [items, setItems] = useState<ServerGeneration[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const buildUrl = useCallback((offset: number) => { /* ...PAGE_SIZE=20... */ }, [params]);

  const refetch = useCallback(async () => { /* offset=0, setItems(...)  */ }, [buildUrl]);
  const loadMore = useCallback(async () => { /* offset=items.length, append */ }, [buildUrl, items.length]);

  useEffect(() => { void refetch(); }, [refetch]);
  useEffect(() => {
    const h = () => void refetch();
    window.addEventListener(REFRESH_EVENT, h);
    return () => window.removeEventListener(REFRESH_EVENT, h);
  }, [refetch]);

  return { items, hasMore, isLoading, isLoadingMore, error, loadMore, refetch };
}
```

- `PAGE_SIZE = 20`, `hasMore = lastBatch.length >= PAGE_SIZE`.
- Формат ISO для `startDate`/`endDate`: `start.setHours(0,0,0,0); start.toISOString()` и `end.setHours(23,59,59,999)` — ровно как в эталоне.
- В `history-sidebar.tsx` — кнопка "Load more" внизу списка когда `hasMore && !isLoading`.

### Шаг 4. Дебаунс `triggerHistoryRefresh` 1500ms

В `components/history-sidebar.tsx` (там где сейчас экспортируется `triggerHistoryRefresh`):
```ts
let _refreshTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_DEBOUNCE_MS = 1500;
export function triggerHistoryRefresh() {
  if (_refreshTimer) clearTimeout(_refreshTimer);
  _refreshTimer = setTimeout(() => {
    _refreshTimer = null;
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
    }
  }, REFRESH_DEBOUNCE_MS);
}
```
Никаких других правок — сигнатура та же, generate-form.tsx не трогаем.

### Шаг 5. Date-range фильтр (UI)

Это самый тяжёлый шаг из-за зависимостей. У нас в `package.json` нет `react-day-picker`, `date-fns`, `@radix-ui/react-popover`. Варианты:

**5а (рекомендуется, минимум зависимостей):** два нативных `<input type="date">` side-by-side в шапке сайдбара под кнопкой "Filters". Дефолт — последние 7 дней (считаем через `new Date(Date.now() - 7*86400000)`). Парсим в `Date`, передаём в `useHistory`. Форматирование в ISO для URL — в хуке. Ноль новых зависимостей, UX попроще чем у viewcomfy, но функционал тот же.

**5б (эталонный UX):** поставить `react-day-picker@9`, `date-fns@4`, `@radix-ui/react-popover`, портировать shadcn `Calendar` + `Popover` компоненты в `components/ui/`, портировать `date-picker-with-range.tsx`. ~3 новых зависимости, ~400 строк нового UI-кода. Делать только если юзер скажет "хочу точно как на скрине".

**Решение:** начинаем с **5а**, если юзер скажет "хочу календарик-popover как в viewcomfy" — апгрейдим на 5б отдельной подитерацией.

Кнопка "Filters" в шапке сайдбара — toggle, показывает/прячет блок с двумя date-инпутами. Состояние `date: { from: Date; to: Date }` хранится в `HistorySidebar` и пробрасывается в `useHistory`.

### Шаг 6. Drag-n-drop из истории в дропзону

- В `ServerEntryCard` на `<img>` миниатюры добавить `draggable` + `onDragStart` — кладём в `e.dataTransfer` кастомный MIME `application/x-viewcomfy-media` (сохраняем совместимость с viewcomfy-эталоном) со **оригинальным** URL:
  ```ts
  e.dataTransfer.setData("application/x-viewcomfy-media", JSON.stringify({ url: fullSrc, filename, contentType }));
  e.dataTransfer.effectAllowed = "copy";
  ```
- В `components/image-dropzone.tsx` в обработчике `onDrop` — сначала проверить `dataTransfer.types.includes("application/x-viewcomfy-media")`, если да — распарсить JSON, `fetch(url) → blob → File` и прокинуть в `onChange` тем же путём, что и обычный drag файлов с диска.
- Обработать тонкость: fetch того же origin идёт без CORS, всё ок.

## НЕ трогать в 4c

- `app/api/history/route.ts` POST-хендлер — бэкенд thumb/mid уже правильный.
- `stores/history-store.ts` — останется до итерации 5 (чистка локального zustand после переезда output-area на сервер).
- `output-area.tsx` — остаётся на локальном store.
- `components/generate-form.tsx` — `triggerHistoryRefresh` вызывается по той же сигнатуре, дебаунс прозрачный.

## Smoke test после 4c

1. **mid в диалоге.** DevTools → Network, открыть модалку у новой записи — должен быть запрос `mid_*.png` ~200-500KB вместо `<uuid>.png` в несколько MB.
2. **thumb/mid fallback.** Удалить вручную `thumb_*.jpg` одного файла из `data/history_images/`, F5 — миниатюра не битая, грузится оригинал (через onError).
3. **blob-кеш.** Открыть модалку записи, закрыть, открыть снова — во второй раз zero network requests (blob://).
4. **Пагинация.** Сгенерировать вручную 25+ записей (или временно уменьшить `PAGE_SIZE` до 5) — показывается первые 20, кнопка "Load more", по клику дозагружаются оставшиеся.
5. **Дебаунс.** Запустить 3 генерации подряд (если возможно) — в Network один-единственный `GET /api/history` через 1.5с после последней.
6. **Date filter.** Выбрать диапазон "вчера-вчера" — список пустой (если сегодня не было старых). Выбрать "последние 30 дней" — показывает всё. URL в Network должен содержать `startDate=...&endDate=...`.
7. **Drag-n-drop.** Зажать картинку в истории, перетащить в дропзону формы — появляется как входное изображение.

## Команда для следующей сессии

```
Продолжаем wavespeed-claude. Прочитай ITERATION-4C-TODO.md
в корне проекта — там полный план перформанс-итерации 4c
(трёхуровневые разрешения, blob-кеш, пагинация, дебаунс,
date-range фильтр, drag-n-drop из истории).

Контекст: 4a и 4b закрыты (server-backed history + POST из
generate-form + модалка через адаптер). Бэкенд уже генерирует
thumb/mid через sharp — это часть 4a. GET принимает
startDate/endDate. На фронте ничего из этого не используется.

Эталон — viewcomfy-claude на уровень выше:
E:\my_stable\viewcomfy\viewcomfy-claude\hooks\use-local-history.tsx
E:\my_stable\viewcomfy\viewcomfy-claude\components\history-sidebar.tsx
E:\my_stable\viewcomfy\viewcomfy-claude\components\ui\date-picker-with-range.tsx

Идём шагами 1→6 в порядке TODO. Для шага 5 (date filter)
стартуем с варианта 5а (нативные <input type="date">),
без новых npm-зависимостей — swr/react-day-picker/date-fns
в проект не тащим.

Путь: E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude
```
