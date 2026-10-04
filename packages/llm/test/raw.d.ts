// Vite's `?raw` imports a file's text, for the recorded streams.
declare module "*?raw" {
  const content: string;
  export default content;
}
