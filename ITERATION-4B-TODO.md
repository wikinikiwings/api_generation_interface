# ITERATION 4B — TODO

> Создан после успешного завершения итерации **4a** (server-backed history-sidebar + image serving endpoint). Это памятка для следующей сессии после ресета лимитов.

## Что уже работает (итерация 4a)

- ✅ `app/api/history/image/[filename]/route.ts` — стримит файлы из `HISTORY_IMAGES_DIR` с защитой от traversal и `Cache-Control: immutable`
- ✅ `components/history-sidebar.tsx` — переписан на `GET /api/history?username=X`, refetch по window-event `wavespeed:history-refresh`, DELETE через сервер, парсинг SQLite `created_at`, рендер thumb_<uuid>.jpg
- ✅ Smoke test: для `test_user` показывает 0 записей (правильно, пустая dev-БД), для `max_k`/`wikinik` подтянутся реальные viewcomfy-записи (юзер тестирует)

## РЕГРЕССИЯ (известная, фикс в 4b)

**Клик по картинке в истории открывает её в новой вкладке вместо модалки.**

Причина: при переписывании `history-sidebar.tsx` я заменил `<ImageDialog>` на простой `<a target="_blank">`, потому что старый `ImageDialog` принимает `HistoryEntry` (zustand-shape), а сервер отдаёт `ServerGeneration` (snake_case, другое поле картинки). Быстрый shortcut, но UX потерян — модалка с зумом/копированием/инфой исчезла.

**Фикс в 4b:** один из вариантов
1. **Адаптер-функция** в `history-sidebar.tsx`: `serverGenToHistoryEntry(g: ServerGeneration): HistoryEntry` — собирает фейковый HistoryEntry с `outputUrl = imgUrl(filepath)`, `inputThumbnails = []`, `model = workflow_name`, и т.д. Передаём в существующий `<ImageDialog>` без правки самого диалога. **Минимум изменений, рекомендуется.**
2. Расширить `ImageDialog` на дискриминированный union (`HistoryEntry | ServerGeneration`). Дороже.
3. Сделать новый `<ServerImageDialog>`. Дублирование.

→ **Идём вариантом 1.** Прочитать `components/image-dialog.tsx` чтобы понять, какие поля HistoryEntry он реально использует, и собрать минимальный валидный объект-адаптер.

## Основная задача итерации 4b: POST в `/api/history` из generate-form

В `components/generate-form.tsx` после успешной генерации (в **обеих** ветках, sync/async) сделать запись на сервер:

### Шаги
1. Импортировать `useUser` из `@/app/providers/user-provider` и `triggerHistoryRefresh` из `@/components/history-sidebar`.
2. Прочитать `username` через `useUser()` в теле компонента.
3. После `toast.success("Готово!")` — вызвать новую async-функцию `saveToServerHistory(...)` (объявить внутри компонента). Не блокировать main flow — вызывать через `void` и ловить ошибки toast-ом.

### Что отправлять (multipart FormData)

```
username: string                          // из useUser, пропустить если null
workflowName: string                      // "wavespeed:" + activeProvider + "/nano-banana-pro/" + (hasImages ? "edit" : "t2i")
promptData: JSON.stringify({              // наш EditInput для совместимости с viewcomfy schema
  prompt,
  resolution,
  aspectRatio: aspectRatio || undefined,
  outputFormat,
  provider: activeProvider,               // wavespeed | fal | comfy
  model: getModelString(...),
  inputThumbnails: thumbnails,            // для возможности показать что было на входе
})
executionTimeSeconds: (executionTimeMs / 1000).toString()
output_0: File                            // см. ниже как получить
```

### Как получить File из outputUrl

`outputUrl` — это локальный путь типа `/generated/<uuid>.png` (см. `lib/image-storage.ts`). Конвертация:

```typescript
async function urlToFile(url: string, fallbackName: string): Promise<File> {
  const res = await fetch(url);
  const blob = await res.blob();
  const name = url.split("/").pop() || fallbackName;
  return new File([blob], name, { type: blob.type || "image/png" });
}
```

### Edge cases / страховки

- Если `username` пустой → пропустить POST с `console.warn`. Модалка не должна пускать сюда, но страховка обязательна.
- Если POST упал → `toast.error("История не сохранилась: " + msg)` но **не** менять статус локального zustand entry (картинка уже видна юзеру).
- POST идёт **параллельно** с локальным `updateHistory` — никакого race.
- После успешного POST вызвать `triggerHistoryRefresh()` чтобы сайдбар подтянул новую запись.

### НЕ трогать в 4b
- `stores/history-store.ts` — оставить, удаление в итерации 5
- `output-area.tsx` — продолжает читать локальный store
- `image-dialog.tsx` — только если адаптер-вариант 1 потребует мелкой правки (вряд ли)

## Команда для следующей сессии

```
Продолжаем wavespeed-claude. Прочитай ITERATION-4B-TODO.md
в корне проекта — там полный план итерации 4b и фикс
регрессии с открытием картинки в новой вкладке.

Контекст: итерация 4a закрыта (server-backed history-sidebar
+ /api/history/image endpoint). Юзер протестировал на test_user,
max_k, wikinik — список и удаление работают, но клик по
картинке открывает её в новой вкладке вместо модалки. Это
известная регрессия, фикс — адаптер ServerGeneration → HistoryEntry
для существующего <ImageDialog>.

Приступай к 4b: сначала фикс регрессии (читай image-dialog.tsx,
напиши адаптер в history-sidebar.tsx, верни <ImageDialog>),
потом основная задача — POST в /api/history из generate-form.tsx
с triggerHistoryRefresh после успеха. Подробности в TODO-файле.

Путь проекта:
E:\my_stable\viewcomfy\viewcomfy-claude\wavespeed-claude
```

## Smoke test для 4b (когда закончим)

1. Открыть страницу как `test_user`, нажать "Сгенерировать" с любым промптом
2. После завершения генерации сайдбар автоматически рефрешится и показывает новую запись (через `triggerHistoryRefresh()`)
3. Кликнуть на картинку в сайдбаре → открывается **модалка** (не новая вкладка) ← регрессия пофикшена
4. Закрыть модалку, перезагрузить страницу → запись на месте (читается с сервера)
5. Сменить ник на `max_k` через удаление cookie + refresh → видны старые viewcomfy записи + НЕТ записи `test_user` (правильная изоляция по username)
6. Записи через DevTools → SQLite browser в `data/history.db` — должна быть строка с `workflow_name = "wavespeed:wavespeed/nano-banana-pro/t2i"` или похожим
7. Файл картинки физически лежит в `data/history_images/<uuid>.png` + `thumb_<uuid>.jpg` + `mid_<uuid>.png`
