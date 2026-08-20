const TelegramBot = require("node-telegram-bot-api");

const TOKEN = "8618742398:AAGWL2fS8kBYcSC4fHtpeo68sm1u320T7Gg";
const MINI_APP_URL = "https://tver-benches.onrender.com/";

const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  const keyboard = {
    reply_markup: {
      keyboard: [
        [{ text: "Открыть карту скамеек", web_app: { url: MINI_APP_URL } }],
      ],
      resize_keyboard: true,
    },
  };

  bot.sendMessage(
    chatId,
    "🪑 *Скамейки Твери*\n\n" + "Нажмите кнопку ниже, чтобы открыть карту!",
    { parse_mode: "Markdown", ...keyboard },
  );
});

console.log("Бот запущен");
