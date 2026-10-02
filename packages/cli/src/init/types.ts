/** Run wrangler in the deployment repo on the person's terminal, so they see its output and answer its prompts. Returns its exit code. */
export type RunWranglerInteractive = (args: string[]) => Promise<number | null>;

/** Everything `artfct init` reaches outside the process. */
export type InitEnvironment = {
  repoDir: string;
  /** The template the CLI package ships. */
  templateDir: string;
  runWrangler: RunWranglerInteractive;
  announceStep: (step: string) => void;
};

/** How `artfct init` ended. A failed run names the step that stopped it and how to recover. */
export type InitReport =
  | { outcome: "done" }
  | { outcome: "failed"; step: string; problem: string; recovery: string };
