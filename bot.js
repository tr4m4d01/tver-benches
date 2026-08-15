const TelegramBot = require("node-telegram-bot-api");
require("dotenv").config();

const TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;

const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const user = msg.from;

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "🪑 Открыть карту скамеек", web_app: { url: MINI_APP_URL } }],
      ],
      resize_keyboard: true,
    },
  };

  bot.sendMessage(
    chatId,
    "🪑 *Скамейки Твери*\n\n" +
      "Привет, " +
      user.first_name +
      "!\n\n" +
      "Нажмите кнопку ниже, чтобы открыть карту скамеек.",
    { parse_mode: "Markdown", ...keyboard },
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    "ℹ️ *Помощь*\n\n" +
      "/start - Начать\n" +
      "/help - Помощь\n\n" +
      'Нажмите кнопку "🪑 Открыть карту скамеек" для запуска',
    { parse_mode: "Markdown" },
  );
});

console.log("🤖 Бот запущен");
