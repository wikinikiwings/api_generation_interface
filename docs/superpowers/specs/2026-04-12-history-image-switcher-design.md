# История генераций: листание изображений как в Output-сегодня

**Дата:** 2026-04-12
**Статус:** Дизайн утверждён, готов к написанию плана имплементации.

## Проблема

В рабочей области **Output-сегодня** при клике на тайл открывается `ImageDialog`, внутри которого работают стрелки `←` / `→` и клавиатурная навигация — можно листать между сегодняшними генерациями без закрытия диалога.

В **Истории генераций** (`history-sidebar.tsx` → `ServerEntryCard`) при клике на карточку открывается тот же `ImageDialog`, но **без `siblings`** — листать между записями истории невозможно. Пользователь вынужден закрывать диалог, искать следующую карточку в sidebar, открывать её заново.

Цель — дать в истории тот же UX листания, что уже работает в Output-сегодня.

## Scope и non-goals

### В scope
- Листание между записями истории в открытом `ImageDialog` стрелками `←` / `→` и клавишами.
- Визуальные виджеты листания 1:1 идентичны Output-сегодня (chevrons, градиенты, keyboard handler).
- Автоматическая дозагрузка (`loadMore`) при подходе к концу загруженных записей.
- Live-обновление `siblings` при SSE-событиях (создание, удаление).
- Корректная обработка удаления записи, которую пользователь сейчас смотрит.

### Вне scope (явно НЕ делаем)
- Sidebar scroll-sync / подсветка текущей карточки в sidebar.
- Глобальный `useImageNavigation` hook / вынос в shared — follow-up, когда появится третий потребитель.
- Глобальный `ViewerStore` поверх Zustand.
- **Multi-output внутри одной генерации** (листание между `gen.outputs[]`) — отдельная задача, не связанная с этой.
- Cross-context siblings (листать между Output-сегодня и Историей в одной модалке).
- Новые keyboard shortcuts вне `ImageDialog`.
- Изменения API `/api/history` или SSE-протокола.
- Тост-уведомления об удалении / появлении записей.

## Собранные требования (итоги брейншторма)

| № | Решение |
|---|---------|
| 1 | Листаем **между записями истории** (вариант A из Q1) — не multi-output внутри генерации. |
| 2 | Scope siblings — **уже загруженные + авто-prefetch** (вариант B из Q2). |
| 3 | Включаем **completed + подтверждённые pending с готовым blob-превью** (вариант C из Q3); failed/cancelled/loading пропускаются. |
| 4 | **Prefetch за 2–3 позиции до конца** с fallback на spinner, если пользователь обогнал загрузку (вариант B из Q4). |
| 5 | **Без sidebar-sync** (вариант A из Q5) — sidebar остаётся как был. |
| 6 | **Live-обновление siblings через SSE** (вариант B из Q6); при удалении текущей записи — смещаемся к соседу по старому индексу, clamped к новой длине; при пустом списке — закрываем диалог. |

## Архитектура

Три изменения:

### 1. Новый хук `hooks/use-history-siblings.ts`
Надстройка над существующим `useHistory()`. Возвращает:

```ts
interface UseHistorySiblingsResult {
  siblings: HistoryEntry[];   // reactive, отфильтрованный, отсортированный
  loadMore: () => void;
  hasMore: boolean;
  loading: boolean;
}
```

**Поведение:**
- Берёт `entries` из `useHistory()`.
- Конвертирует server-entries через существующий `serverGenToHistoryEntry` (`lib/server-gen-adapter.ts`).
- Фильтрует: оставляет только записи со статусом `completed` ИЛИ pending-записи с валидным blob-превью (имеют `previewUrl`/`originalUrl`).
- Сортирует: `desc` по `createdAt` (так же, как sidebar).
- Мемоизирует результат (меняется только если меняется `entries`).
- Прокидывает `loadMore` / `hasMore` / `loading` из `useHistory`.

### 2. `components/history-sidebar.tsx` → `ServerEntryCard`
- Вызывает `useHistorySiblings()` в родительском компоненте (`HistorySidebar`) — один раз, не в каждой карточке.
- Передаёт `siblings` и колбэки вниз через props (а не через React context — чтобы не скрывать зависимости).
- В `ServerEntryCard` при открытии `ImageDialog` вычисляет `initialIndex = siblings.findIndex(s => s.id === entry.id)`.
- Передаёт `<ImageDialog siblings={siblings} initialIndex={initialIndex} onNearEnd={handleNearEnd} />`.
- `handleNearEnd` вызывает `loadMore()` если `hasMore && !loading`.

### 3. `components/image-dialog.tsx` — точечные доработки

**3.1. Id-tracking вместо чистого index-tracking.**
Сейчас `currentIdx` — просто `useState<number>`. Меняем логику:
- Храним `currentId: string` (ID текущей записи) в state.
- `currentIdx` — computed: `siblings.findIndex(s => s.id === currentId)`.
- При `initialIndex` — инициализируем `currentId = siblings[initialIndex]?.id ?? entry.id`.
- `goNext` / `goPrev` — находят текущий `id`, сдвигают index, записывают новый `id` в state.
- **Backwards compat с Output:** текущий API `initialIndex` сохраняется; если siblings без стабильных `id` — fallback на index-based (но у нас все siblings — `HistoryEntry` с `id`, так что в реальности fallback не нужен).

**3.2. Prop `onNearEnd?: (remainingAhead: number) => void`.**
- После каждого изменения `currentIdx` проверяем: если `(siblings.length - currentIdx - 1) <= 2`, зовём `onNearEnd(remaining)`.
- Throttled / dedup-ed: не зовём повторно, если `remainingAhead` не уменьшился с прошлого вызова.

**3.3. Handling "текущая запись пропала из siblings".**
- Effect на `siblings`: если `siblings.find(s => s.id === currentId)` отсутствует:
  - Был ли старый idx? Берём `min(oldIdx, siblings.length - 1)`.
  - Если `siblings.length === 0` → `onOpenChange(false)`.
  - Иначе → `setCurrentId(siblings[clampedIdx].id)`.

**3.4. Pending → confirmed transition.**
Когда pending-запись подтверждается сервером, `id` может измениться (pending локальный UUID → server `serverGenId` в адаптере). Чтобы модалка не "схлопнулась":
- В `useHistorySiblings` опционально трекаем алиас: если в предыдущем siblings был `id=X` с `serverGenId=Y`, и в новом нет `id=X`, но есть запись с `serverGenId=Y` → считаем их одной и той же записью для целей навигации.
- `ImageDialog` получает вспомогательный prop `resolveCurrentId?: (currentId, newSiblings) => string | null` (или эта логика инкапсулирована в `useHistorySiblings` + exported helper). **Упрощение:** в `serverGenToHistoryEntry` уже используется стабильный id от сервера, а `pending-history` проставляет `id = uuid`; реальная трансформация id происходит в `useHistory.merge` через dedup. Проверить на этапе имплементации, что в итоге pending-карточка и её server-версия имеют одинаковый `id` (обычно да — uuid сохраняется) — тогда этот edge case решается сам. Если нет — добавляем alias-map.

### Что НЕ меняется
- `hooks/use-history.ts` — без изменений.
- `lib/server-gen-adapter.ts` — без изменений.
- `lib/pending-history.ts` — без изменений.
- `components/output-area.tsx` — без изменений (не должно регрессировать).
- API, SSE-протокол, схема БД — без изменений.

## Data flow

**Открытие модалки:**
1. Клик по `ServerEntryCard` → trigger children открывает `ImageDialog`.
2. Хук в `HistorySidebar` уже держит актуальные `siblings` и `loadMore`.
3. `initialIndex = siblings.findIndex(s => s.id === entry.id)`. Если `-1` → fallback `siblings = [entry]`, `initialIndex = 0` (листать нечего, но картинку показываем).

**Листание →:**
1. `goNext()` находит текущий id, сдвигает index, обновляет `currentId`.
2. После смены: проверка `remainingAhead ≤ 2` → `onNearEnd(remainingAhead)`.
3. `onNearEnd` в `HistorySidebar` → `loadMore()` если `hasMore && !loading`.
4. `useHistory.loadMore()` → GET `/api/history?offset=N` → state обновляется → siblings пересчитывается → модалка получает более длинный массив reactively.

**SSE `generation.created` во время открытой модалки:**
1. `broadcastHistoryRefresh` → `useHistory.fetchFirstPage()` → entries обновлены.
2. `useHistorySiblings` → новый массив (новая запись в начале).
3. `ImageDialog` получает новый prop `siblings`; computed `currentIdx` сдвигается на `+1`, т.к. `currentId` не поменялся.

**SSE `generation.deleted` не-текущей записи:**
1. Refetch → запись пропадает из entries → из siblings.
2. `currentIdx` пересчитывается по id → может уменьшиться.

**SSE `generation.deleted` текущей записи:**
1. Effect "текущий id пропал" → `clampedIdx = min(oldIdx, siblings.length - 1)`.
2. Если `siblings.length === 0` → `onOpenChange(false)`.
3. Иначе → `currentId = siblings[clampedIdx].id`.

## Визуальное соответствие Output-сегодня

**Никаких новых UI-элементов не добавляется.** Все виджеты листания — это существующая реализация `ImageDialog`:
- `ChevronLeft` / `ChevronRight` overlay (`components/image-dialog.tsx:332–355`) — hover на левой/правой четверти.
- Градиент-fade на краях.
- Keyboard handler ← / → / Esc (`components/image-dialog.tsx:192–201`).
- FLIP-анимация на open/close.
- `ZoomableImage` (wheel, pinch, drag).

Эти элементы условно рендерятся при `siblings.length > 1`. Как только История передаёт массив с длиной `> 1`, весь этот UX включается автоматически и идентично Output-сегодня.

**Контракт:** если на проверке окажется, что из Истории виджеты выглядят или ведут себя иначе, чем из Output — это баг, а не фича.

## Edge cases (полный список)

| # | Случай | Поведение |
|---|--------|-----------|
| 1 | Siblings пустой при открытии | Невозможно (открываем из существующей карточки); fallback `siblings=[entry]`. |
| 2 | `initialIndex === -1` (запись отфильтрована) | `siblings = [entry]`, стрелки скрыты, dev-лог. |
| 3 | `hasMore === false`, дошли до конца | `→` не рендерится на последней позиции. |
| 4 | Пользователь обогнал prefetch | Spinner поверх image area, `→` временно disabled, после прихода страницы — разблок. |
| 5 | `loadMore` вернул 0 записей | `hasMore → false`, штатное достижение края. |
| 6 | SSE вставил новую запись выше текущей | `currentIdx` сдвинется на `+1`, UX "справа столько же, слева +1". |
| 7 | SSE удалил не-текущую запись | Исчезает из siblings; `currentIdx` перевычислится по id. |
| 8 | SSE удалил текущую запись | `clampedIdx = min(oldIdx, siblings.length-1)`; если пусто — `onOpenChange(false)`. Без тоста. |
| 9 | Fetch error при `loadMore` | `useHistory` логирует; в модалке без UI-ошибки, повторный `→` пере-вызовет `onNearEnd` → `loadMore`. |
| 10 | Pending → confirmed во время просмотра | Если id сохраняется — работает прозрачно. Иначе нужен alias через `serverGenId` (проверить на имплементации). |
| 11 | Две вкладки с открытыми модалками | Независимые local state + общий SSE → каждая ведёт себя корректно. |
| 12 | Скролл sidebar под модалкой | Не влияет: siblings завязан на entries, не на viewport. |
| 13 | Zoom активен, `→` | `ZoomableImage` re-mount по `entry.id` сбрасывает zoom (уже работает). |

## Testing

### Ручная проверка (обязательная)
1. Открыть модалку из sidebar — `←` / `→` появляются, работают кликом и клавишами; визуально 1:1 с Output.
2. Долистать до конца первой страницы — `loadMore` сработал за 2 позиции до конца, без flicker.
3. `hasMore=false` — `→` исчезает на последней.
4. Две вкладки, создать генерацию в одной — во второй siblings обновляется, `currentIdx` корректен.
5. Удалить текущую запись из другой вкладки — модалка остаётся на соседе.
6. Удалить все видимые — модалка закрывается.
7. Pending-запись с blob-превью листается; при подтверждении не "схлопывается".
8. Zoom → `→` сбрасывает zoom.
9. Медленный сеть (2с на loadMore): spinner виден, `→` disabled до ответа.
10. **Regression:** Output-сегодня — открытие, листание, удаление работают без изменений.

### Автотесты (если инфраструктура есть в проекте)
Юнит-тесты для `useHistorySiblings`:
- filter: только completed + pending с blob;
- sort: desc по `createdAt`;
- reactivity: entries меняются → siblings пересчитывается;
- `loadMore` / `hasMore` прокидываются из `useHistory`.

Если test infra отсутствует — TypeScript strict + ручное тестирование + dev-логи достаточно для MVP.

## Критерии приёмки

- [ ] Клик по любой карточке sidebar открывает модалку с рабочими `←` / `→` (при `siblings.length > 1`).
- [ ] Виджеты листания визуально идентичны Output-сегодня.
- [ ] Prefetch срабатывает за 2 позиции до конца; пользователь может долистать до самой старой записи без interruption.
- [ ] SSE-события (`created`, `deleted`) корректно live-обновляют siblings.
- [ ] Удаление текущей записи смещает к соседу; опустошение siblings закрывает модалку.
- [ ] Output-сегодня работает без регрессий.
- [ ] TypeScript strict проходит без новых ошибок.

## Ключевые файлы

| Файл | Роль |
|------|------|
| `hooks/use-history-siblings.ts` | **Новый.** Хук поверх `useHistory` с filter+sort+reactive siblings. |
| `components/history-sidebar.tsx` | Вызов `useHistorySiblings` в `HistorySidebar`, передача в `ServerEntryCard`, `onNearEnd` обработчик. |
| `components/image-dialog.tsx` | Id-tracking; prop `onNearEnd`; effect "текущий id пропал → clamp / close". |
| `hooks/use-history.ts` | **Без изменений.** |
| `lib/server-gen-adapter.ts` | **Без изменений.** |
| `lib/pending-history.ts` | **Без изменений.** |
| `components/output-area.tsx` | **Без изменений**, проверить на регрессии. |

## Follow-ups (не в этой итерации)

- Выделить `useImageNavigation` в shared hook — когда появится третий потребитель.
- Sidebar scroll-sync / подсветка текущей карточки — по запросу пользователя.
- Multi-output per generation — отдельная задача.
