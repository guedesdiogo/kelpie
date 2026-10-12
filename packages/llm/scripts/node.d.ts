// The few Node APIs the scripts use. `@types/node` can't be installed: Bun's isolated linker would
// make Node's globals visible to every workspace (see tools/release/src/node.d.ts).

declare module "node:fs/promises" {
  export function mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<string | undefined>;
  export function writeFile(path: string, data: string): Promise<void>;
}
