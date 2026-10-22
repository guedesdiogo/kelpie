// Telegram updates, hand-built from the Bot API docs (https://core.telegram.org/bots/api, read on
// 2026-10-04). Replace them with recorded updates once the owner's bot exists (Story 3.6, #39).

const owner = { id: 1001, is_bot: false, first_name: "Diogo", username: "owner" };
const privateChat = { id: 1001, type: "private", first_name: "Diogo" };
/** Saturday 3 October 2026, 23:30 in São Paulo, in Unix seconds. */
export const SENT = 1_791_081_000;

const update = (message: Record<string, unknown>, updateId = 900_001) => ({
  update_id: updateId,
  message: { message_id: 42, from: owner, chat: privateChat, date: SENT, ...message },
});

export const privateText = update({ text: "where is my order?" });
export const reply = update({ text: "that one", reply_to_message: { message_id: 41 } });
export const groupText = update({
  chat: { id: -100_200, type: "supergroup", title: "Team" },
  text: "hi all",
});
export const photoWithCaption = update({
  photo: [
    { file_id: "small", file_unique_id: "s", width: 90, height: 90 },
    { file_id: "large", file_unique_id: "l", width: 1280, height: 1280 },
  ],
  caption: "the receipt",
});
export const pdf = update({
  document: {
    file_id: "doc-1",
    file_unique_id: "d",
    file_name: "a.pdf",
    mime_type: "application/pdf",
  },
});
export const voice = update({
  voice: { file_id: "voice-1", file_unique_id: "v", duration: 3, mime_type: "audio/ogg" },
});
export const sticker = update({
  sticker: { file_id: "st", file_unique_id: "st", type: "regular", width: 512, height: 512 },
});
export const fromBot = update({
  from: { id: 7, is_bot: true, first_name: "Other bot" },
  text: "beep",
});
export const edited = {
  update_id: 900_002,
  edited_message: {
    message_id: 42,
    from: owner,
    chat: privateChat,
    date: SENT,
    edit_date: SENT + 60,
    text: "where is my order now?",
  },
};
export const channelPost = {
  update_id: 900_003,
  channel_post: {
    message_id: 5,
    chat: { id: -100_300, type: "channel" },
    date: SENT,
    text: "news",
  },
};
export const blockedByUser = {
  update_id: 900_004,
  my_chat_member: { chat: privateChat, from: owner, date: SENT },
};
/** A post a linked channel relayed into its discussion group, sent by Telegram's service account. */
export const relayedChannelPost = update({
  chat: { id: -100_200, type: "supergroup", title: "Team" },
  from: { id: 777_000, is_bot: false, first_name: "Telegram" },
  is_automatic_forward: true,
  text: "news from the channel",
});
export const withoutSender = update({ from: undefined, text: "who?" });

const kelpieBot = { id: 555, is_bot: true, first_name: "Kelpie", username: "kelpie_bot" };
/** A tap on a button under one of the bot's notices (ADR-0067 §3). */
const callback = (fields: Record<string, unknown>, updateId = 900_005) => ({
  update_id: updateId,
  callback_query: {
    id: "4382bfdwdsb323b2d9",
    from: { ...owner, language_code: "pt-br" },
    message: {
      message_id: 43,
      from: kelpieBot,
      chat: privateChat,
      date: SENT,
      text: "Confirme: change the tier.",
    },
    chat_instance: "-7015413208734",
    data: "confirm:0f1e2d3c4b5a69788796a5b4c3d2e1f0",
    ...fields,
  },
});

export const press = callback({});
export const groupPress = callback({
  message: { message_id: 43, from: kelpieBot, chat: { id: -100_200, type: "supergroup" }, date: 0 },
});
export const channelPress = callback({
  message: { message_id: 43, chat: { id: -100_300, type: "channel" }, date: SENT },
});
/** A tap on a message sent in inline mode: Telegram names no chat, only the inline message. */
export const inlinePress = callback({ message: undefined, inline_message_id: "AAAA" });
export const gamePress = callback({ data: undefined, game_short_name: "snake" });
export const pressFromBot = callback({ from: { id: 7, is_bot: true, first_name: "Other bot" } });
export { callback as pressWith };
