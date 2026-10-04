// Drizzle's Durable Object migrations import their SQL as text (a wrangler `Text` module rule).
declare module "*.sql" {
  const sql: string;
  export default sql;
}
