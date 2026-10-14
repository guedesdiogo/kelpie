// The few Node and Bun APIs the runner and its tests use. `@types/node` can't be installed: Bun's
// isolated linker would expose Node's globals to every workspace, where they clash with the Workers
// types (as tools/release/src/node.d.ts explains).

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
  getuid(): number;
};

declare const Bun: {
  serve(options: {
    hostname: string;
    port: number;
    /** False: an error answers a bare 500, never Bun's page with the source and its path. */
    development: boolean;
    fetch: (request: Request) => Response | Promise<Response>;
  }): unknown;
};

declare module "node:crypto" {
  export function createHash(algorithm: "sha256"): {
    update(data: string): { digest(): Uint8Array };
  };
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
}

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function statSync(path: string): { mode: number };
  export function openSync(path: string, flags: number): number;
  export function fstatSync(fd: number): { mode: number; uid: number; isFile(): boolean };
  export function closeSync(fd: number): void;
  export function symlinkSync(target: string, path: string): void;
  export function mkdirSync(path: string): void;
  export const constants: { O_RDONLY: number; O_NOFOLLOW: number };
  export function writeFileSync(path: string, data: string, options?: { mode?: number }): void;
  export function chmodSync(path: string, mode: number): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { force?: boolean; recursive?: boolean }): void;
}

declare module "node:os" {
  export function homedir(): string;
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
