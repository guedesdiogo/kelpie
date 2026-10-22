import { type Locale, type Localized, localeOf, type ModelKey } from "@kelpie/channels";

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
  /** The secure form for the VPS runner's secret (#294). */
  runner: {
    title: string;
    intro: string;
    label: string;
    button: string;
    empty: string;
    invalid: string;
    refused: string;
    unreachable: string;
    notConfigured: { title: string; body: string };
    connected: string;
    done: (version: string) => string;
    outdated: (version: string) => string;
  };
  /** The secure form for a model key (ADR-0068). `names` name each slot's key. */
  modelKey: {
    title: string;
    names: Record<ModelKey, string>;
    intro: (name: string) => string;
    label: string;
    button: string;
    empty: string;
    invalid: string;
    refused: string;
    unreachable: string;
    saved: string;
    done: (name: string) => string;
    unchecked: (name: string) => string;
  };
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
      body: "Connect the agent's Telegram bot first: ask Master, or run the <code>connectTelegram</code> command.",
    },
    noAgent: {
      title: "No such agent",
      body: "Check the link, or ask Master for a new one.",
    },
    runner: {
      title: "Connect the runner",
      intro:
        "Paste the secret in <code>~/.config/kelpie-runner/secret</code> on your server. Kelpie checks it with the runner, then keeps it in its secret store.",
      label: "Runner secret",
      button: "Connect",
      empty: "Paste the runner's secret first.",
      invalid:
        "That isn't a runner secret: it has at least 32 characters and no spaces. Copy it again from the server.",
      refused: "The runner didn't accept that secret. Copy it again from the server.",
      unreachable:
        "Kelpie couldn't reach the runner. Check that it and cloudflared are running on the server, then try again.",
      notConfigured: {
        title: "No runner configured",
        body: "Kelpie was deployed without the runner's VPC Service, so it can't check a secret. <code>docs/runner.md</code> says how to set it up.",
      },
      connected: "Runner connected",
      done: (version) =>
        `The runner, version ${version}, now answers Kelpie. You can close this page.`,
      outdated: (version) =>
        `The secret is stored, but the runner (version ${version}) speaks another protocol version than this Kelpie. Update it on the server, as <code>docs/runner.md</code> says.`,
    },
    modelKey: {
      title: "Set a model key",
      names: {
        anthropic: "Anthropic API key",
        openai: "OpenAI API key",
        "ai-gateway": "AI Gateway token",
        typesafe: "TypeSafe API key (Jev)",
      },
      intro: (name) =>
        `Paste the ${name}. Kelpie checks it with its service, then keeps it in its secret store, encrypted. It never reaches the chat or a model.`,
      label: "Key",
      button: "Save",
      empty: "Paste the key first.",
      invalid:
        "That doesn't look like a key: it has 16 to 512 characters and no spaces. Copy it again.",
      refused: "The service didn't accept that key. Check it and paste it again.",
      unreachable: "Kelpie couldn't reach the service to check the key. Try again in a moment.",
      saved: "Key saved",
      done: (name) =>
        `The ${name} is saved. Kelpie's models use it within a minute. You can close this page.`,
      unchecked: (name) =>
        `The ${name} is saved, but Kelpie couldn't check it with its service: a wrong key shows only when a call that uses it fails. Kelpie's models use it within a minute. You can close this page.`,
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
      body: "Conecte primeiro o bot do Telegram do agente: peça ao Master, ou rode o comando <code>connectTelegram</code>.",
    },
    noAgent: {
      title: "Esse agente não existe",
      body: "Confira o link, ou peça um novo ao Master.",
    },
    runner: {
      title: "Conectar o runner",
      intro:
        "Cole o segredo que está em <code>~/.config/kelpie-runner/secret</code> no seu servidor. O Kelpie confere com o runner e depois o guarda no cofre de segredos.",
      label: "Segredo do runner",
      button: "Conectar",
      empty: "Cole o segredo do runner primeiro.",
      invalid:
        "Isso não é um segredo do runner: ele tem pelo menos 32 caracteres e nenhum espaço. Copie de novo do servidor.",
      refused: "O runner não aceitou esse segredo. Copie de novo do servidor.",
      unreachable:
        "O Kelpie não conseguiu falar com o runner. Confira se ele e o cloudflared estão rodando no servidor e tente de novo.",
      notConfigured: {
        title: "Nenhum runner configurado",
        body: "O Kelpie foi publicado sem o VPC Service do runner, então não tem como conferir um segredo. O <code>docs/runner.md</code> explica como configurar.",
      },
      connected: "Runner conectado",
      done: (version) =>
        `O runner, versão ${version}, agora responde ao Kelpie. Pode fechar esta página.`,
      outdated: (version) =>
        `O segredo foi guardado, mas o runner (versão ${version}) fala outra versão do protocolo que este Kelpie. Atualize-o no servidor, como diz o <code>docs/runner.md</code>.`,
    },
    modelKey: {
      title: "Definir uma chave de modelo",
      names: {
        anthropic: "a chave da API da Anthropic",
        openai: "a chave da API da OpenAI",
        "ai-gateway": "o token do AI Gateway",
        typesafe: "a chave da API da TypeSafe (Jev)",
      },
      intro: (name) =>
        `Cole aqui ${name}. O Kelpie confere o valor com o serviço e o guarda criptografado no cofre de segredos. Ele nunca passa pelo chat nem por um modelo.`,
      label: "Chave",
      button: "Salvar",
      empty: "Cole a chave primeiro.",
      invalid:
        "Isso não parece uma chave: ela tem de 16 a 512 caracteres e nenhum espaço. Copie de novo.",
      refused: "O serviço não aceitou essa chave. Confira e cole de novo.",
      unreachable:
        "O Kelpie não conseguiu falar com o serviço para conferir a chave. Tente de novo daqui a pouco.",
      saved: "Chave salva",
      done: (name) =>
        `Salvo: ${name}. Os modelos do Kelpie começam a usar o valor em até um minuto. Pode fechar esta página.`,
      unchecked: (name) =>
        `Salvo: ${name}, mas o Kelpie não conseguiu conferir o valor com o serviço: um valor errado só aparece quando falhar uma chamada que o usa. Os modelos do Kelpie começam a usar o valor em até um minuto. Pode fechar esta página.`,
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
      page: "Presiona el botón de la página.",
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
      body: "Expiró, ya se usó o se rechazó demasiadas veces. Pide uno nuevo.",
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
        `Abre <a href="${href}" rel="noreferrer">este enlace</a> en Telegram y presiona Iniciar. Funciona una vez, durante los próximos ${minutes} minutos, y uno nuevo reemplaza al anterior.`,
    },
    noBot: {
      title: "Todavía no hay bot",
      body: "Conecta primero el bot de Telegram del agente: pídeselo al Master, o ejecuta el comando <code>connectTelegram</code>.",
    },
    noAgent: {
      title: "Ese agente no existe",
      body: "Revisa el enlace, o pide uno nuevo al Master.",
    },
    runner: {
      title: "Conectar el runner",
      intro:
        "Pega el secreto que está en <code>~/.config/kelpie-runner/secret</code> en tu servidor. Kelpie lo comprueba con el runner y luego lo guarda en su almacén de secretos.",
      label: "Secreto del runner",
      button: "Conectar",
      empty: "Pega primero el secreto del runner.",
      invalid:
        "Eso no es un secreto del runner: tiene al menos 32 caracteres y ningún espacio. Cópialo de nuevo desde el servidor.",
      refused: "El runner no aceptó ese secreto. Cópialo de nuevo desde el servidor.",
      unreachable:
        "Kelpie no pudo hablar con el runner. Comprueba que él y cloudflared están en marcha en el servidor e inténtalo de nuevo.",
      notConfigured: {
        title: "Ningún runner configurado",
        body: "Kelpie se publicó sin el VPC Service del runner, así que no puede comprobar un secreto. <code>docs/runner.md</code> explica cómo configurarlo.",
      },
      connected: "Runner conectado",
      done: (version) =>
        `El runner, versión ${version}, ya responde a Kelpie. Puedes cerrar esta página.`,
      outdated: (version) =>
        `El secreto quedó guardado, pero el runner (versión ${version}) habla otra versión del protocolo que este Kelpie. Actualízalo en el servidor, como dice <code>docs/runner.md</code>.`,
    },
    modelKey: {
      title: "Definir una clave de modelo",
      names: {
        anthropic: "la clave de API de Anthropic",
        openai: "la clave de API de OpenAI",
        "ai-gateway": "el token de AI Gateway",
        typesafe: "la clave de API de TypeSafe (Jev)",
      },
      intro: (name) =>
        `Pega aquí ${name}. Kelpie comprueba el valor con su servicio y lo guarda cifrado en su almacén de secretos. Nunca pasa por el chat ni por un modelo.`,
      label: "Clave",
      button: "Guardar",
      empty: "Pega la clave primero.",
      invalid:
        "Eso no parece una clave: tiene de 16 a 512 caracteres y ningún espacio. Cópiala de nuevo.",
      refused: "El servicio no aceptó esa clave. Revísala y pégala de nuevo.",
      unreachable:
        "Kelpie no pudo comunicarse con el servicio para comprobar la clave. Inténtalo de nuevo en un momento.",
      saved: "Clave guardada",
      done: (name) =>
        `Guardado: ${name}. Los modelos de Kelpie empiezan a usar el valor en menos de un minuto. Puedes cerrar esta página.`,
      unchecked: (name) =>
        `Guardado: ${name}, pero Kelpie no pudo comprobar el valor con su servicio: un valor erróneo solo se nota cuando falla una llamada que lo usa. Los modelos de Kelpie empiezan a usar el valor en menos de un minuto. Puedes cerrar esta página.`,
    },
  },
};
