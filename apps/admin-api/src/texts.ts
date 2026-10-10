import { type Locale, type Localized, localeOf } from "@kelpie/channels";

// The admin API's pages in English, Brazilian Portuguese and Spanish (#187). What comes from
// elsewhere, such as an agent's id or a bot's name, is passed in already escaped.

/**
 * A page's language: the one its link names (`?lang=`, which the links Kelpie sends carry), else
 * the browser's first choice, else English. A form posts to its own URL, so its answer keeps it.
 */
export function pageLocale(request: Request): Locale {
  const named = new URL(request.url).searchParams.get("lang");
  return localeOf(named) ?? localeOf(request.headers.get("accept-language")) ?? "en";
}

export interface PageTexts {
  signIn: { title: string; body: string };
  notAllowed: { title: string; ownForm: string; ownPage: string; ownerOnly: string };
  notSubmission: { title: string; form: string; page: string };
  tooLarge: { title: string; body: string };
  connect: {
    title: string;
    intro: (agent: string) => string;
    label: string;
    button: string;
    empty: string;
    invalid: string;
    refused: string;
  };
  connected: {
    title: string;
    used: (bot: string, agent: string) => string;
    done: (bot: string, agent: string) => string;
    noWebhook: (bot: string, agent: string, reason: string) => string;
  };
  closed: { title: string; body: string };
  unavailable: { title: string; body: string };
  pair: {
    title: string;
    intro: (name: string, id: string) => string;
    button: string;
    open: (href: string, minutes: number) => string;
  };
  noBot: { title: string; body: string };
  noAgent: { title: string; body: string };
}

export const PAGES: Localized<PageTexts> = {
  en: {
    signIn: { title: "Sign in first", body: "Open this link in your browser again." },
    notAllowed: {
      title: "Not allowed",
      ownForm: "This form only accepts its own submissions.",
      ownPage: "This page only accepts its own submissions.",
      ownerOnly: "Only the owner can use this link.",
    },
    notSubmission: {
      title: "Not a form submission",
      form: "Submit the token from the form page.",
      page: "Press the button on the page.",
    },
    tooLarge: { title: "Too large", body: "That isn't a bot token." },
    connect: {
      title: "Connect Telegram",
      intro: (agent) =>
        `Paste the token BotFather gave you for the bot that answers as ${agent}. It goes straight to Kelpie's secret store.`,
      label: "Bot token",
      button: "Connect",
      empty: "Paste the bot token first.",
      invalid: "That doesn't look like a bot token. Copy it again from BotFather.",
      refused: "Telegram didn't accept that token. Check it in BotFather and paste it again.",
    },
    connected: {
      title: "Telegram connected",
      used: (bot, agent) =>
        `This link was already used: ${bot} answers for ${agent}. You can close this page.`,
      done: (bot, agent) => `${bot} now answers for ${agent}. You can close this page.`,
      noWebhook: (bot, agent, reason) =>
        `${bot} is connected to ${agent}, but Telegram couldn't be pointed at Kelpie (${reason}). Until it is, messages to the bot do not reach Kelpie. Once that is fixed, run the <code>registerTelegramWebhook</code> command for ${agent}.`,
    },
    closed: {
      title: "This link no longer works",
      body: "It expired, was used, or was refused too many times. Ask for a new one.",
    },
    unavailable: { title: "Try again later", body: "Kelpie couldn't reach its secret store." },
    pair: {
      title: "Pair Telegram",
      intro: (name, id) =>
        `Pair your own Telegram account with the bot of ${name} (${id}). You get a link to open in Telegram, where you are logged in; the account that opens it becomes yours in Kelpie.`,
      button: "Get the link",
      open: (href, minutes) =>
        `Open <a href="${href}" rel="noreferrer">this link</a> in Telegram and press Start. It works once, for the next ${minutes} minutes, and a new one replaces it.`,
    },
    noBot: {
      title: "No bot yet",
      body: "Connect the agent's Telegram bot first: ask the setup agent, or run the <code>connectTelegram</code> command.",
    },
    noAgent: {
      title: "No such agent",
      body: "Check the link, or ask the setup agent for a new one.",
    },
  },
  "pt-BR": {
    signIn: { title: "Entre primeiro", body: "Abra este link de novo no seu navegador." },
    notAllowed: {
      title: "Não permitido",
      ownForm: "Este formulário só aceita envios feitos por ele mesmo.",
      ownPage: "Esta página só aceita envios feitos por ela mesma.",
      ownerOnly: "Só o dono pode usar este link.",
    },
    notSubmission: {
      title: "Não é um envio de formulário",
      form: "Envie o token pela página do formulário.",
      page: "Toque no botão da página.",
    },
    tooLarge: { title: "Grande demais", body: "Isso não é um token de bot." },
    connect: {
      title: "Conectar o Telegram",
      intro: (agent) =>
        `Cole o token que o BotFather deu para o bot que responde como ${agent}. Ele vai direto para o cofre de segredos do Kelpie.`,
      label: "Token do bot",
      button: "Conectar",
      empty: "Cole o token do bot primeiro.",
      invalid: "Isso não parece um token de bot. Copie de novo do BotFather.",
      refused: "O Telegram não aceitou esse token. Confira no BotFather e cole de novo.",
    },
    connected: {
      title: "Telegram conectado",
      used: (bot, agent) =>
        `Este link já foi usado: ${bot} responde por ${agent}. Pode fechar esta página.`,
      done: (bot, agent) => `${bot} agora responde por ${agent}. Pode fechar esta página.`,
      noWebhook: (bot, agent, reason) =>
        `${bot} está conectado a ${agent}, mas não foi possível apontar o Telegram para o Kelpie (${reason}). Até lá, as mensagens para o bot não chegam ao Kelpie. Depois de corrigir isso, rode o comando <code>registerTelegramWebhook</code> para ${agent}.`,
    },
    closed: {
      title: "Este link não funciona mais",
      body: "Ele expirou, já foi usado ou foi recusado vezes demais. Peça um novo.",
    },
    unavailable: {
      title: "Tente de novo mais tarde",
      body: "O Kelpie não conseguiu acessar o cofre de segredos.",
    },
    pair: {
      title: "Parear o Telegram",
      intro: (name, id) =>
        `Pareie sua própria conta do Telegram com o bot de ${name} (${id}). Você recebe um link para abrir no Telegram, onde está conectado; a conta que abrir o link passa a ser sua no Kelpie.`,
      button: "Gerar o link",
      open: (href, minutes) =>
        `Abra <a href="${href}" rel="noreferrer">este link</a> no Telegram e toque em Iniciar. Funciona uma vez, nos próximos ${minutes} minutos, e um novo substitui o anterior.`,
    },
    noBot: {
      title: "Ainda sem bot",
      body: "Conecte primeiro o bot do Telegram do agente: peça ao agente de setup, ou rode o comando <code>connectTelegram</code>.",
    },
    noAgent: {
      title: "Esse agente não existe",
      body: "Confira o link, ou peça um novo ao agente de setup.",
    },
  },
  es: {
    signIn: { title: "Inicia sesión primero", body: "Abre este enlace de nuevo en tu navegador." },
    notAllowed: {
      title: "No permitido",
      ownForm: "Este formulario solo acepta sus propios envíos.",
      ownPage: "Esta página solo acepta sus propios envíos.",
      ownerOnly: "Solo el propietario puede usar este enlace.",
    },
    notSubmission: {
      title: "No es un envío de formulario",
      form: "Envía el token desde la página del formulario.",
      page: "Pulsa el botón de la página.",
    },
    tooLarge: { title: "Demasiado grande", body: "Eso no es un token de bot." },
    connect: {
      title: "Conectar Telegram",
      intro: (agent) =>
        `Pega el token que BotFather te dio para el bot que responde como ${agent}. Va directo al almacén de secretos de Kelpie.`,
      label: "Token del bot",
      button: "Conectar",
      empty: "Pega primero el token del bot.",
      invalid: "Eso no parece un token de bot. Cópialo de nuevo desde BotFather.",
      refused: "Telegram no aceptó ese token. Revísalo en BotFather y pégalo de nuevo.",
    },
    connected: {
      title: "Telegram conectado",
      used: (bot, agent) =>
        `Este enlace ya se usó: ${bot} responde por ${agent}. Puedes cerrar esta página.`,
      done: (bot, agent) => `${bot} ahora responde por ${agent}. Puedes cerrar esta página.`,
      noWebhook: (bot, agent, reason) =>
        `${bot} está conectado a ${agent}, pero no se pudo apuntar Telegram a Kelpie (${reason}). Hasta entonces, los mensajes al bot no llegan a Kelpie. Cuando eso esté resuelto, ejecuta el comando <code>registerTelegramWebhook</code> para ${agent}.`,
    },
    closed: {
      title: "Este enlace ya no funciona",
      body: "Caducó, ya se usó o se rechazó demasiadas veces. Pide uno nuevo.",
    },
    unavailable: {
      title: "Inténtalo de nuevo más tarde",
      body: "Kelpie no pudo llegar a su almacén de secretos.",
    },
    pair: {
      title: "Vincular Telegram",
      intro: (name, id) =>
        `Vincula tu propia cuenta de Telegram con el bot de ${name} (${id}). Recibes un enlace para abrir en Telegram, donde tienes la sesión iniciada; la cuenta que lo abra pasa a ser tuya en Kelpie.`,
      button: "Obtener el enlace",
      open: (href, minutes) =>
        `Abre <a href="${href}" rel="noreferrer">este enlace</a> en Telegram y pulsa Iniciar. Funciona una vez, durante los próximos ${minutes} minutos, y uno nuevo reemplaza al anterior.`,
    },
    noBot: {
      title: "Todavía no hay bot",
      body: "Conecta primero el bot de Telegram del agente: pídeselo al agente de configuración, o ejecuta el comando <code>connectTelegram</code>.",
    },
    noAgent: {
      title: "Ese agente no existe",
      body: "Revisa el enlace, o pide uno nuevo al agente de configuración.",
    },
  },
};
