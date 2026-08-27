-- ============================================================================
--  Migration 001: Telegram-based authentication
--  Применяется к таблице users для перехода на авторизацию через Telegram WebApp.
--  Безопасно к повторному запуску (проверки IF NOT EXISTS / PRAGMA).
-- ============================================================================

-- telegram_id хранится как TEXT, чтобы не потерять точность 64-битных ID
-- Telegram в JavaScript. Уникальность гарантируется индексом.
ALTER TABLE users ADD COLUMN telegram_id TEXT DEFAULT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);

-- Профильные поля, которые приложение берёт из initData Telegram.
ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN last_name  TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN username   TEXT DEFAULT NULL;
ALTER TABLE users ADD COLUMN photo_url  TEXT DEFAULT NULL;

-- Старые колонки login / password больше не используются (парольная
-- аутентификация удалена). Их можно оставить «мёртвыми» или удалить позже:
--   ALTER TABLE users DROP COLUMN password;  -- SQLite >= 3.35 / D1
--   ALTER TABLE users DROP COLUMN login;

-- ----------------------------------------------------------------------------
--  Перенос существующих пользователей
-- ----------------------------------------------------------------------------
--  У старых аккаунтов (созданных по login/password) поле telegram_id пустое.
--  Автоматически связать их с Telegram невозможно (нет общего ключа), поэтому
--  при первом входе через WebApp будет создан НОВЫЙ аккаунт. Чтобы сохранить
--  старый профиль (скамейки, отзывы, рейтинг), привяжите telegram_id вручную:
--
--    UPDATE users
--    SET telegram_id = '<TELEGRAM_USER_ID>'
--    WHERE id = <OLD_USER_ID>;
--
--  После этого вход через Telegram будет использовать именно этот аккаунт
--  (данные имени/username обновятся из initData при логине).
-- ============================================================================
