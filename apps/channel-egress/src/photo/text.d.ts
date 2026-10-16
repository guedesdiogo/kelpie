// The webchat's mascot files, linked here as `.txt` and imported as text (a wrangler `Text` module
// rule): Browser Run's page runs them to draw the bot's photo (ADR-0046).
declare module "*.txt" {
  const text: string;
  export default text;
}
