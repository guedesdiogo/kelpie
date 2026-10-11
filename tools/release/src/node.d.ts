// The few Node APIs this tool and its tests use. `@types/node` can't be installed: Bun's isolated
// linker links any package into its shared fallback folder (`node_modules/.bun/node_modules`),
// where every workspace's dependencies would find Node's globals, which clash with the Workers
// types.

declare const process: {
  argv: string[];
  env: Record<string, string | undefined>;
  pid: number;
  cwd(): string;
  exit(code?: number): never;
};

interface ImportMeta {
  dirname: string;
}

declare module "node:child_process" {
  type Stdio = Array<"ignore" | "pipe" | "inherit">;
  export function execFileSync(
    file: string,
    args: readonly string[],
    options: { cwd?: string; encoding: "utf8"; maxBuffer?: number; stdio?: Stdio },
  ): string;
  export interface ChildProcess {
    stdout: unknown;
    stderr: unknown;
    on(event: "error", listener: (error: Error) => void): this;
    on(event: "close", listener: (code: number | null) => void): this;
  }
  export function spawn(
    command: string,
    args: readonly string[],
    options: { cwd?: string; env?: Record<string, string | undefined>; stdio?: Stdio },
  ): ChildProcess;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function appendFileSync(path: string, data: string): void;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function readdirSync(path: string): string[];
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
}

declare module "node:readline" {
  export interface Interface {
    on(event: "line", listener: (line: string) => void): this;
  }
  export function createInterface(options: { input: unknown }): Interface;
}

declare module "node:util" {
  type Option = { type: "string" } | { type: "boolean"; default?: boolean };
  type Value<O extends Option> = O extends { type: "boolean"; default: boolean }
    ? boolean
    : O extends { type: "boolean" }
      ? boolean | undefined
      : string | undefined;
  export function parseArgs<Options extends Record<string, Option>>(config: {
    args: string[];
    allowPositionals: boolean;
    options: Options;
  }): { values: { [Name in keyof Options]: Value<Options[Name]> }; positionals: string[] };
  export function isDeepStrictEqual(a: unknown, b: unknown): boolean;
}
