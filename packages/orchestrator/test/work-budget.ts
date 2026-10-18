import type { Logger } from "drizzle-orm/logger";

/** The most store statements one step of the workflow world may run. A settled step runs a few hundred at most. */
const ACTION_WORK_BUDGET = 5_000;

/** The step that runs now, and the store statements counted when it began. */
type RunningStep = { label: string; statementsAtStart: number };

/** Stop a step of the workflow world that ran past its work budget. */
function exceededWorkBudget(step: string, work: number): never {
  throw new Error(
    `work budget: ${step} ran ${work} store statements, past the budget of ${ACTION_WORK_BUDGET}`,
  );
}

/**
 * A drizzle logger that counts every statement the store runs. A step that runs past its work
 * budget stops there, so a livelock fails with its sequence instead of hanging the run.
 */
export class WorkBudget implements Logger {
  private statements = 0;
  private running: RunningStep | null = null;

  logQuery(): void {
    this.statements += 1;
    const running = this.running;
    const work = running ? this.statements - running.statementsAtStart : 0;
    if (running && work > ACTION_WORK_BUDGET) exceededWorkBudget(running.label, work);
  }

  /** The step that runs now, or null between steps. */
  runningStep(): RunningStep | null {
    return this.running;
  }

  /**
   * Run one step of a sequence or a replay that drives the world, and fail it when it ran more
   * store statements than the work budget. A step that another step's work overlapped is not
   * measured, since its count holds that work too.
   */
  async within<Result>(label: string, run: () => Promise<Result>): Promise<Result> {
    const running = { label, statementsAtStart: this.statements };
    this.running = running;
    const result = await run();
    const work = this.statements - running.statementsAtStart;
    if (this.running !== running) return result;
    this.running = null;
    if (work > ACTION_WORK_BUDGET) exceededWorkBudget(label, work);
    return result;
  }
}
