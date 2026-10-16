/** A file's text, as Vite's `?raw` import gives it. */
declare module "*?raw" {
  const text: string;
  export default text;
}
