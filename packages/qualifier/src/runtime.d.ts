// Timers exist in every runtime Kelpie targets (workerd and Node), but this package compiles
// without DOM or Node typings to stay runtime-agnostic, so it declares the two it uses.
declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
