# PRD: Озвучка статьи (OpenAI TTS)

## Цель
Добавить в панель плеер “как в Telegram”: кнопка Play/Pause, прогресс‑бар, текущее время/длительность (приблизительная). По нажатию проигрывается озвучка Markdown статьи.

## Scope
- Источник текста: `articleExtractMd` (Markdown статьи).
- TTS: OpenAI `v1/audio/speech`.
- Воспроизведение — внутри страницы (HTMLAudioElement).
- Пауза/продолжение/стоп.

## Важные факты про OpenAI TTS
- API: `POST /v1/audio/speech`. ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))
- Модели: `gpt-4o-mini-tts`, `tts-1`, `tts-1-hd`. ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))
- Есть набор голосов (например `alloy`, `nova`, `shimmer`, `marin`, `cedar` и т.д.). ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))
- Поддерживаются форматы: `mp3`, `opus`, `wav`, `aac`, `flac`, `pcm`. ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))
- Требование по политике: пользователю нужно явно сообщить, что голос AI‑генерированный. ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))

## UX
- В панели рядом со слайдером (или ниже):
  - Play/Pause (toggle)
  - Stop
  - прогресс (0:00 / 12:34)
  - тонкий таймлайн как в Telegram
- Лейбл: “AI‑озвучка” (дисклеймер).

## Поведение
1. Пользователь нажимает Play.
2. Если аудио ещё не создано — отправить запрос в TTS API и начать загрузку.
3. После получения аудио — проигрывание через `<audio>`:
   - `play()` / `pause()` / `currentTime = 0`
4. Таймлайн обновляется по `timeupdate`.

## Архитектура

### Вариант A (проще, но длинные статьи тяжелее)
- Одним запросом отправлять весь текст (ограничение по токенам).
- Получать целиком mp3.
- Минус: большие статьи могут превышать лимиты, долго ждать.

### Вариант B (рекомендуемый)
- Разбивать Markdown на чанки (например 1200–1500 токенов).
- Запрашивать по чанку.
- Склеивать в один Blob (либо плейлист).
- Итог: стабильнее, можно показывать прогресс загрузки.

## Ограничения
- 2000 input tokens у `gpt-4o-mini-tts` на один запрос (важно для chunking). ([platform.openai.com](https://platform.openai.com/docs/models/gpt-4o-mini-tts?utm_source=openai))
- Возможны разные наборы голосов по моделям. ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))
- Лимиты RPM/TPM зависят от тарифа. ([platform.openai.com](https://platform.openai.com/docs/models/gpt-4o-mini-tts?utm_source=openai))

## Предложение по реализации

### API вызов
```
POST /v1/audio/speech
{
  "model": "gpt-4o-mini-tts",
  "voice": "marin",
  "input": "<chunk text>",
  "response_format": "mp3"
}
```
([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))

### UI‑состояния
- Idle → Loading → Playing → Paused → Stopped
- В Loading показывать спиннер/прогресс загрузки.

### Дисклеймер
Внизу панели: “AI‑озвучка (сгенерировано)”. ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))

## Вопросы для решения
1. Модель: `gpt-4o-mini-tts` (по умолчанию) или `tts-1/tts-1-hd`?
2. Голос: какой предпочитаем? (`marin`/`cedar` — рекомендованные для качества). ([platform.openai.com](https://platform.openai.com/docs/guides/text-to-speech?utm_source=openai))
3. Chunking: делаем сразу? (рекомендуется).
