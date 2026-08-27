# Скамейки Твери (tver-benches)

Мини-апп для поиска и добавления скамеек в Твери. Клиентская часть — одностраничник
на Leaflet/OSM, авторизация — прозрачно через Telegram WebApp (initData + JWT).
Сервер — Express, данные хранятся в Cloudflare D1 (через HTTP API).

## Требования

- Node.js >= 18
- Аккаунт Cloudflare D1 (база данных + API-токен)
- Telegram-бот (получить `TELEGRAM_BOT_TOKEN` у @BotFather)

## Переменные окружения

Создайте файл `.env` в корне проекта (он уже в `.gitignore`):

| Переменная         | Обязательна | Назначение                                                        |
| ------------------ | ----------- | ----------------------------------------------------------------- |
| `D1_ACCOUNT_ID`    | да          | ID аккаунта Cloudflare                                            |
| `D1_DATABASE_ID`   | да          | ID базы данных D1                                                 |
| `D1_API_TOKEN`     | да          | API-токен Cloudflare с доступом к D1                             |
| `TELEGRAM_BOT_TOKEN` | да       | Токен бота (для проверки подписи initData)                       |
| `JWT_SECRET`       | да (прод)  | Секрет для подписи JWT. В dev генерируется случайный при запуске |
| `PORT`             | нет         | Порт сервера (по умолчанию 3000)                                  |
| `CORS_ORIGIN`      | нет         | Разрешённый origin CORS (по умолчанию `https://tver-benches.onrender.com`) |
| `NODE_ENV`         | нет         | `production` включает прод-режим (отключает dev-логин)            |
| `DEV_MODE`         | нет         | `true` включает `/api/auth/dev-login` вне production              |

Пример `.env`:

```dotenv
D1_ACCOUNT_ID=xxxxxxxxxxxxxxxxxxxx
D1_DATABASE_ID=xxxxxxxxxxxxxxxxxxxx
D1_API_TOKEN=xxxxxxxxxxxxxxxxxxxx
TELEGRAM_BOT_TOKEN=123456:ABC-DEFxxxx
JWT_SECRET=очень-длинный-случайный-секрет
CORS_ORIGIN=https://tver-benches.onrender.com
```

## Локальный запуск

```bash
npm install
npm start
```

Сервер поднимется на `http://localhost:PORT`. База создаётся/мигрирует автоматически
при старте (`initDatabase()`). В dev-режиме войти можно через `/api/auth/dev-login`,
если не внутри Telegram WebApp.

## Деплой (Render)

1. Залейте репозиторий на GitHub/GitLab и создайте новый **Web Service** на Render.
2. Build command: `npm install`
3. Start command: `npm start`
4. В разделе **Environment** добавьте все переменные из таблицы выше
   (`NODE_ENV=production` и `JWT_SECRET` обязательно).
5. Укажите `CORS_ORIGIN` равным URL вашего сервиса на Render.
6. В настройках бота (@BotFather → Menu Button / Web App) укажите URL мини-аппа.

После деплоя:
- главная страница отдаётся по `/`;
- админ-панель защищена на уровне Express (`/admin` требует прав админа);
- API доступно по `/api/*`.

## Структура

- `server.js` — Express-сервер, D1-интерфейс, авторизация, API.
- `public/index.html` — клиентская часть мини-аппа.
- `private/admin.html` — админ-панель (отдаётся только авторизованным админам).
- `bot.js` — Telegram-бот (опционально).
- `migrations/` — SQL-миграции.

## Безопасность

- Авторизация только через Telegram WebApp initData (проверка HMAC по `TELEGRAM_BOT_TOKEN`).
- `auth_date` из initData отклоняется, если старше 24 часов (допустимо небольшое
  расхождение часов — подпись всё равно проверяется бот-токеном).
- `/api/auth/telegram` и dev-логин защищены rate limiting (10 запросов/минута по IP).
- Админ-панель недоступна без прав администратора (JWT).
