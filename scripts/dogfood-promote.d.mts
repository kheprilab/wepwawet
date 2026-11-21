export interface RewriteTarget {
  node: string;
  entry: string;
}

export interface RewireResult {
  rewritten: string[];
  skippedTracked: string[];
  skippedInvalid: string[];
}

export interface PromoteOptions {
  cwd?: string;
  fetch?: boolean;
  force?: boolean;
  log?: (message: string) => void;
}

export type PromoteResult =
  | { status: "no-harness" }
  | { status: "busy" }
  | ({ status: "promoted" | "current"; commit: string } & RewireResult);

export function rewriteCommand(command: unknown, target: RewriteTarget): string | undefined;
// biome-ignore lint/suspicious/noExplicitAny: hook configs are arbitrary JSON.
export function rewriteHookConfig(config: any, target: RewriteTarget): { value: any; changed: number };
export function rewireHooks(root: string, target: RewriteTarget): Promise<RewireResult>;
export interface SwapFs {
  existsSync(path: string): boolean;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

export function swapInto(staging: string, target: string, fs?: SwapFs): void;
export function acquireLock(dir: string): (() => void) | undefined;
export function promote(options?: PromoteOptions): Promise<PromoteResult>;
