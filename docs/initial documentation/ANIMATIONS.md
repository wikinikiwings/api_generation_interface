# ANIMATIONS — подсказка для wavespeed-claude

Краткий справочник по тому, как в этом проекте устроены анимации UI,
какие у стека есть подводные камни, и как их обходить. Стек:
**Tailwind 3 + tailwindcss-animate 1.0 + Radix UI + shadcn-style
обёртки** (см. `components/ui/dialog.tsx` и т.п.).

---

## 1. Стек и как он работает

### tailwindcss-animate
Плагин из `package.json`. Добавляет утилиты типа `animate-in`,
`fade-in-0`, `zoom-in-95`, `slide-in-from-top-2` и т.д.

**Ключевая идея:** все эти утилиты НЕ генерируют отдельный keyframe
на каждое сочетание. Вместо этого они выставляют CSS-переменные
(`--tw-enter-opacity`, `--tw-enter-scale`, `--tw-enter-translate-x/y`,
`--tw-enter-rotate`), а единственный общий keyframe `enter` читает
эти переменные:

```css
@keyframes enter {
  from {
    opacity: var(--tw-enter-opacity, 1);
    transform:
      translate3d(var(--tw-enter-translate-x, 0), var(--tw-enter-translate-y, 0), 0)
      scale3d(var(--tw-enter-scale, 1), var(--tw-enter-scale, 1), var(--tw-enter-scale, 1))
      rotate(var(--tw-enter-rotate, 0));
  }
}
```

Аналогично для `exit` и `--tw-exit-*`. Это значит:

- На время анимации `transform` элемента **полностью переписывается**
  keyframe'ом. Любые `translate-x-*`, `-translate-y-1/2`, `rotate-*`,
  `scale-*`, заданные классами или inline, в момент анимации
  **исчезают**, если они не подложены через `--tw-enter-*` переменные.
- `transform-origin` keyframe НЕ трогает — оно работает как
  обычно, через CSS-каскад. Inline `style={{ transformOrigin }}`
  применяется честно.

### Radix + shadcn DialogContent
`components/ui/dialog.tsx` центрирует диалог так:
```
fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2
```
Это **transform-based** центрирование. И это главный источник граблей —
см. секцию 3.

---

## 2. Цикл состояния через `data-state`

Radix вешает на элемент атрибут `data-state="open" | "closed"`. Анимации
триггерятся через варианты Tailwind:

```tsx
"data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95"
"data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
```

Это даёт автоматическую анимацию закрытия — Radix задерживает unmount
до завершения CSS-animation.

**Не пытайся** триггерить open-анимацию через JS-классы — Radix сам
управляет `data-state`, и борьба с ним приводит к двойным анимациям
или мерцанию.

---

## 3. Грабля №1: keyframe затирает центрирующий transform

**Симптом:** Dialog/Popover/Tooltip "вылетает" не из ожидаемой точки,
а из угла экрана (часто визуально читается как "правый нижний").

**Причина:** shadcn центрирует через `-translate-x-1/2 -translate-y-1/2`,
keyframe `enter` ставит `transform: translate3d(0, 0, 0) scale3d(...)` на
старте. На один кадр элемент теряет центрирующий offset → его левый
верхний угол прыгает в центр экрана → keyframe скейлит из этой точки.

**Решение:** заменить transform-центрирование на нечто, живущее ВНЕ
свойства `transform`. Самый чистый способ — `inset-0 + margin: auto`:

```tsx
<DialogContent
  className={
    "!left-0 !top-0 !right-0 !bottom-0 !translate-x-0 !translate-y-0 " +
    "!m-auto !block !h-fit !w-fit " +
    "max-w-[92vw] max-h-[92vh] ..."
  }
>
```

Что важно:
- `!` (important) обязательны — иначе базовые классы из `dialog.tsx`
  победят по специфичности.
- `!translate-x-0 !translate-y-0` обнуляет shadcn-овский центрирующий
  translate, чтобы он не мешал.
- `!block` нужен потому что shadcn ставит `grid`, а `margin: auto` в
  grid-контейнере без явных размеров центрирует не так как в block.
- `!h-fit !w-fit` — чтобы `max-w/max-h` работали, а сам элемент
  усаживался по контенту (иначе `m-auto` не центрирует).
- `inset-0` (`left/top/right/bottom: 0`) + `m-auto` = классический
  трюк "centered fixed box".

Делай это **локально в своём компоненте**, не правь глобальный
`components/ui/dialog.tsx` — другие диалоги в проекте могут зависеть
от его текущего поведения.

См. рабочий пример в `components/image-dialog.tsx`.

---

## 4. Грабля №2: `transform-origin` без фикса грабли №1

`transform-origin` НЕ читается из keyframe (там его нет), но он
применяется во время keyframe-анимации скейла. Значит:

```tsx
style={{ transformOrigin: `calc(50% + ${ox}px) calc(50% + ${oy}px)` }}
```

работает корректно — НО только если решена грабля №1 (иначе элемент
сначала прыгает, а потом скейлится из заданного origin, и origin
вычисляется относительно "прыгнувшего" положения, а не финального).

### Якорение анимации к конкретной точке (origin-aware open)

Алгоритм для "увеличиваться из позиции миниатюры":

1. На триггере поставить `ref`.
2. В `onOpenChange(true)` снять `getBoundingClientRect()` триггера.
3. Посчитать смещение центра триггера от центра вьюпорта:
   ```ts
   const cx = rect.left + rect.width / 2;
   const cy = rect.top + rect.height / 2;
   const ox = cx - window.innerWidth / 2;
   const oy = cy - window.innerHeight / 2;
   ```
4. Передать в `style.transformOrigin` через `calc()`:
   ```ts
   `calc(50% + ${ox}px) calc(50% + ${oy}px)`
   ```
   `50%` — центр самого диалога; добавка в пикселях смещает origin к
   точке кликнутой миниатюры в координатах вьюпорта.

Эта схема работает для любого центрированного фиксированного попапа,
не только Dialog (Popover, HoverCard и т.п. — те же грабли).

---

## 5. Грабля №3: `DialogTrigger asChild` + ref

Если оборачиваешь `children` в свой `<div ref={triggerRef}>` ради
`getBoundingClientRect`, **не используй `className="contents"`** —
у `display: contents` нет собственного бокса, и `getBoundingClientRect`
вернёт нули. Обычный block-div работает; если он ломает соседнюю
flex/grid-разметку, поставь `inline-block` или бери rect у первого
ребёнка вручную через `ref.current?.firstElementChild`.

---

## 6. Грабля №4: React's `onWheel` и `passive: true`

К анимациям не относится напрямую, но раз уж тут zoom/pan — в React 17+
`onWheel` зарегистрирован как passive, и `e.preventDefault()` молча
игнорируется. Если нужно блокировать нативный скролл (кастомный zoom
колесом), регистрируй слушатель руками:

```ts
useEffect(() => {
  const el = containerRef.current;
  if (!el) return;
  const onWheel = (e: WheelEvent) => { e.preventDefault(); /* ... */ };
  el.addEventListener("wheel", onWheel, { passive: false });
  return () => el.removeEventListener("wheel", onWheel);
}, []);
```

Аналогично для `touchstart` / `touchmove` если нужен пинч-зум.
Образец — `ZoomableImage` в `components/image-dialog.tsx`.

---

## 7. Грабля №5: `transition` vs keyframe-анимация

Не путай:
- **`transition`** — плавное изменение CSS-свойства между двумя
  состояниями. Применять для hover/active/focus, для drag-pan, для
  плавного `scale` миниатюры на hover.
- **`animate-in/out`** — keyframe-анимация при mount/unmount или при
  смене `data-state`. Применять для попапов, тостов, dropdown и т.п.

Если поставить `transition-transform` на элемент, у которого keyframe
анимирует `transform`, transition сработает на финальном кадре
keyframe'а и даст лишний "плавающий хвост". Один из двух — выбор
строго.

В `ZoomableImage` мы выключаем transition для panning/wheel-zoom
(`isPanning ? "none" : "transform 120ms ease-out"`) — это случай,
когда плавность нужна для дискретных шагов (double-click), но мешает
для непрерывных жестов.

---

## 8. Чек-лист при добавлении новой анимации

1. **Mount/unmount или hover?** → keyframe (`animate-in`) или
   `transition`, не оба.
2. **Это центрированный fixed-попап?** → проверь, не центрируется ли
   он через `transform`. Если да — переведи на `inset-0 + m-auto`,
   иначе keyframe сломает позиционирование (грабля №1).
3. **Нужна анимация из конкретной точки экрана?** → захвати rect
   триггера, выстави `transformOrigin` через `calc(50% + Xpx)` (грабля
   №2). Сначала убедись, что грабля №1 решена.
4. **Меняешь `transform` инлайн в стиле + он же анимируется
   keyframe'ом?** → вынеси анимируемое значение в `--tw-enter-*`
   переменную или замени класс на свой keyframe.
5. **Нужно блокировать нативный скролл/жест?** → регистрируй
   wheel/touch handlers вручную с `{ passive: false }` (грабля №4).
6. **Тестируй на тайле в разных углах экрана** — баги типа "всплывает
   из правого нижнего" видны только когда триггер не в центре.

---

## 9. Известные рабочие паттерны в проекте

| Паттерн | Файл | Что делает |
|---|---|---|
| Origin-aware Dialog (открывается из точки клика) | `components/image-dialog.tsx` | Рабочий референс на грабли №1 + №2 + №3 |
| Wheel/touch zoom с passive workaround | `components/image-dialog.tsx` (`ZoomableImage`) | Референс на граблю №4 |
| `animate-fade-in` для тайлов Output | `components/output-area.tsx` | Простой keyframe, без позиционных трюков |

---

## 10. Когда что-то не работает — порядок диагностики

1. Открой DevTools → Elements → выбери анимируемый элемент.
2. На вкладке Animations (Chrome) поставь slowdown 25%, переоткрой
   попап. Посмотри на стартовый кадр.
3. Если видно прыжок позиции на первом кадре → грабля №1 (transform
   center перезаписан keyframe'ом).
4. Если позиция норм, но скейл идёт не из той точки → грабля №2
   (`transformOrigin` не задан или вычислен относительно неправильной
   базы).
5. Если анимация вообще не запускается → проверь, действительно ли
   на элементе появляется `data-state="open"` (Radix) или класс
   `animate-in` (ручной триггер).
6. Если двойная анимация / мерцание → ищи `transition` и `animate-*`
   на одном свойстве одновременно (грабля №5).

---

## §6. ImageDialog FLIP — постмортем (3 фикса)

FLIP-анимация в `components/image-dialog.tsx` (открытие диалога «из
кликнутого тайла → в центр») потребовала **трёх независимых правок**
прежде чем заработать. Этот раздел — чтобы при возврате к этому коду
не повторять цикл диагностики.

### Симптом
Клик по тайлу мгновенно показывал диалог в центре без анимации. WAAPI
руками (`$0.animate(...)` в DevTools) работал. CSS-override `!animate-none`
применялся. `console.log` показывал, что callback ref на `DialogContent`
вызывается и `node.animate()` запускается. Но визуально — ничего.

### Грабля №1: className-override проигрывает базовым классам shadcn
`DialogContent` от shadcn использует `cn()` (= `tailwind-merge`) для
мержа классов. Override вида `!left-0 !translate-x-0 !m-auto` **не
доходит до DOM** — на финальной ноде остаются базовые `left-1/2 top-1/2
-translate-x-1/2 -translate-y-1/2`. На ноде висит постоянный
`transform: translate(-50%, -50%)`, который перебивает наш WAAPI.

**Фикс:** перенести centering в `style={{}}` prop. Inline style имеет
наивысший приоритет и **гарантированно** выигрывает у любых Tailwind
утилит, включая `!important`-варианты:
```ts
style={{
  left: 0, top: 0, right: 0, bottom: 0,
  margin: "auto",
  transform: "none",   // KEY: явно убить любой остаточный transform
  width: "fit-content", height: "fit-content",
  maxWidth: "92vw", maxHeight: "92vh",
}}
```
className оставить только для того, что не конфликтует с базовыми
(`!animate-none`, `border-0 bg-transparent p-0 shadow-none`).

**Урок:** при FLIP-анимации над shadcn/Radix-компонентами **не пытайся
перебить базовые transform-классы через className** — используй inline
`style.transform`. Это принципиально, потому что любой остаточный CSS
transform на ноде дерётся с твоей WAAPI-анимацией.

### Грабля №2: callback ref срабатывает несколько раз
React Strict Mode (dev) монтирует/размонтирует/монтирует компонент. Плюс
Radix внутренне делает re-render. В итоге callback ref на DialogContent
вызывается ~3-5 раз подряд. Каждый раз мы запускали новую анимацию.
**Второй вызов измерял ноду уже после первой анимации** —
`getBoundingClientRect()` возвращал её центрированную позицию,
`computeFlipFromRects` давал `{tx:0, ty:0, s:1}`, и пустая
«identity»-анимация перебивала первую правильную.

**Фикс:** гард-флаг + defensive identity check.
```ts
const openAnimPlayedRef = React.useRef(false);
// в callback ref:
if (openAnimPlayedRef.current) return;
openAnimPlayedRef.current = true;
// ...
if (tx === 0 && ty === 0 && s === 1) return; // skip no-op
// сброс в handleOpenChange при open=true и open=false
```

**Урок:** callback ref в React = **не** «один раз при mount». Это
«каждый раз когда DOM-нода привязывается». Если внутри запускается
side-effect (`element.animate()`, измерения, IntersectionObserver) —
**всегда** ставь idempotent-гард.

### Грабля №3: WAAPI `fill: "both"` оставляет transform на ноде
С `fill: "both"` финальное состояние keyframes **остаётся** в
`Element.getAnimations()` поверх любых CSS-стилей. На close это значит,
что следующий open стартует с уже «неправильной» точки. Плюс если у
тебя inline `style.transform = "none"` — он **не вернёт ноду в покой**,
потому что animation-fill-forwards имеет более высокий приоритет.

**Фикс:** `fill: "none"` на open-анимации. После завершения WAAPI
отпускает ноду, и inline `transform: none` берёт управление.
```ts
node.animate([...], { duration: ANIM_OPEN_MS, easing: EASING_OUT, fill: "none" });
```

**Урок:** `fill: "both"`/`"forwards"` нужен **только** когда финальное
состояние WAAPI ≠ финальному CSS-состоянию. Если CSS уже описывает
правильное «покойное» состояние (как у нас через inline style), используй
`fill: "none"` чтобы не оставлять следов.

### Грабля №4: scale > 1 на узких экранах
Формула FLIP-scale была:
```ts
const s = Math.min(thumb.width / cr.width, thumb.height / cr.height);
```
На широком экране тайл маленький (256px), диалог большой → `s ≈ 0.43`,
анимация «вырастает» из тайла. ✅

На узком экране тайл может быть **больше** диалога (grid схлопнулся
в 2 колонки → тайл ≈600px; диалог `fit-content` от ещё-не-загруженного
`<img>` ≈300px). Получается `s > 1` → диалог появляется огромным и
сжимается к центру.

**Фикс:** clamp до 1.
```ts
const raw = Math.min(thumb.width / cr.width, thumb.height / cr.height);
const s = Math.min(raw, 1);
```
Когда тайл больше или равен диалогу — стартуем без zoom, только
translate из позиции тайла к центру. Читается как «диалог скользнул
из тайла».

**Урок:** FLIP с динамическими размерами на обоих концах требует clamp.
Иначе на пограничных размерах формула даёт неожиданные «zoom-out
from huge»-эффекты.

### Финальное состояние
- Open: WAAPI FLIP из тайла в центр (280ms ease-out-expo, `fill: none`).
- Close: простой fade out (220ms, `fill: forwards`), без обратного FLIP.
  Reverse-FLIP считался визуально «убегающим» — fade проще и чище.
- Centering: **inline style**, не className.
- Гард: `openAnimPlayedRef` + identity-skip защищают от Strict Mode
  и повторных callback ref-вызовов.

---

## §7. ImageDialog — навигация между siblings (←/→)

Поверх FLIP-диалога добавлена навигация по соседним тайлам внутри
открытого диалога — не закрывая его и не перезапуская анимацию.

### Архитектурное решение: per-tile dialog + siblings prop
Каждый `OutputCard` по-прежнему оборачивается в свой `<ImageDialog>` —
лифта стейта в родителя не было (это был бы большой рефактор). Вместо
этого каждый диалог получает два дополнительных пропа:
```ts
siblings?: HistoryEntry[];   // полный видимый список
initialIndex?: number;       // позиция этой плитки в списке
```
`siblings` в `output-area.tsx` = результат `useMemo(...)`, то есть все 10
диалогов получают **одну и ту же ссылку**, лишних рендеров нет.

Внутри диалога живёт локальный `currentIdx`, который:
- Сбрасывается в `initialIndex` на каждом открытии диалога.
- Изменяется через `goPrev` / `goNext` (циклически, modulo длины).
- Используется через `currentEntry = siblings[currentIdx] ?? entry`,
  `currentDownloadUrl`, `currentEntry.prompt` и т.д.

### Ключевое взаимодействие с FLIP
`openAnimPlayedRef` из §6 (который изначально был гардом от Strict Mode)
бонусом решает и здесь: переключение `currentIdx` вызывает ререндер `<DialogContent>`,
но callback ref **не запускает новую анимацию** — флаг сбрасывается
**только** в `handleOpenChange` (т.е. при открытии/закрытии), а не при обычных ререндерах.
FLIP играется ровно один раз за сессию диалога. ✅

`ZoomableImage` сбрасывает zoom/pan через свой `useEffect([src])` — смена
картинки автоматически вернёт 1× и (0,0).

### Hover-зоны со стрелками
Две `<button>`-ы, по четверти ширины картинки каждая, `absolute inset-y-0`,
`z-10`. Внутри каждой:
- `<span>` с линейным градиентом (`from-black/35 to-transparent to-50%`).
- `<ChevronLeft/Right>` с `drop-shadow-lg`.

Оба элемента fade-in/out через `opacity-0 group-hover/prev:opacity-100`
(и `group/next` справа). Именованные group-ы Tailwind (`group/<name>`)
нужны из-за вложенности: выше есть `group/nav` на обёртке
изображения, и без имени внутренние `group-hover` ловили бы самый
внешний group, а не свой родитель-кнопку.

```tsx
<button className="group/prev absolute inset-y-0 left-0 z-10 flex w-1/4 ...">
  <span className="... bg-gradient-to-r from-black/35 to-transparent to-50% 
                   opacity-0 transition-opacity duration-200 
                   group-hover/prev:opacity-100" />
  <ChevronLeft className="... opacity-0 transition-opacity duration-200 
                          group-hover/prev:opacity-100" />
</button>
```

`stopPropagation` на кликах стрелок защищает от всплытия к Radix overlay
(который закрыл бы диалог).

### Клавиатурные стрелки
```ts
React.useEffect(() => {
  if (!open || !hasSiblings) return;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft")  { e.preventDefault(); goPrev(); }
    if (e.key === "ArrowRight") { e.preventDefault(); goNext(); }
  };
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}, [open, hasSiblings, goPrev, goNext]);
```
Подписка **только** пока `open === true` — не перехватываем стрелки
глобально (иначе сломали бы поля ввода в форме слева).

### Не забыть про currentEntry везде
При переключении между siblings **всё**, что зависит от текущей картинки,
должно читаться из `currentEntry`, а не из `entry`:
- `<img alt={currentEntry.prompt}>`
- `currentDownloadUrl` (для кнопки Download)
- `a.download = wavespeed-${currentEntry.taskId || currentEntry.id}.${currentEntry.outputFormat}`
- `useEffect([currentEntry.outputUrl])` для сброса `previewSrc` + fallback-флага

Изначальный `entry` остаётся только для проверки `if (!entry.outputUrl) return <>{children}</>` в
самом верху («вообще не рендерить диалог для лоадящейся/сломанной плитки»).

### Accessibility: aria-describedby={undefined}
Radix `DialogContent` ругается в dev: `Missing \`Description\` or 
\`aria-describedby={undefined}\` for {DialogContent}`. Два варианта:
1. Добавить `<DialogDescription>` (требует расширить shadcn-файл
   `components/ui/dialog.tsx` — там такого экспорта нет из коробки).
2. Явно сказать «описание не нужно» через `aria-describedby={undefined}`
   на самом `DialogContent`. **Должно быть именно `undefined` как
   значение пропа**, а не отсутствие пропа — иначе Radix не
   распознает «осознанный отказ» и продолжит варнить.

Выбран вариант 2 — меньше правок, shadcn-файл не тронут. Доступность
сохранена: `DialogTitle` (sr-only) + `<img alt>` полностью описывают
содержимое.

### Edge cases
- `siblings` не передан или `length ≤ 1` → `hasSiblings = false`, стрелки не
  рендерятся, клавиатура не подписывается. Диалог ведёт себя как
  одиночный вьюер.
- Циклическая навигация: `(i - 1 + len) % len` и `(i + 1) % len`. С первой
  «влево» уводит на последнюю, и наоборот.
- `currentIdx` сбрасывается в `initialIndex` при открытии, а не прилипает
  от предыдущей сессии — клик по тайлу #2 всегда открывает именно #2.

### Уроки
1. **`useMemo`-массив безопасно передавать в N дочерних.** Нет повода
   делать большой рефактор с общим диалогом, если ссылка стабильна.
2. **Гард от §6 оказался бонусом.** `openAnimPlayedRef`, изначально
   введённый против Strict Mode, бесплатно решил и вопрос «не
   перезапускать FLIP при ререндере от навигации». Сбрасывать флаг
   **только** в обработчиках открытия/закрытия, никогда в рендере.
3. **Именованные group-ы Tailwind (`group/<name>`)** обязательны при
   вложенных hover-зонах. Безымянный `group-hover` ловит ближайший
   `group` вверх по DOM — если выше есть ещё один, поведение станет
   непредсказуемым.
4. **`window.addEventListener('keydown')` под флагом `open`.** Не
   перехватывать клавиатуру глобально — только в активном
   модальном состоянии. Иначе сломаются input-ы в остальном UI.


