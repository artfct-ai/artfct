import type { WorkflowRuntime } from "../types";
import type { BoardRow } from "./board-store";
import { boardMovedText } from "./render";

type PublishOptions = {
  workflow: WorkflowRuntime;
  row: BoardRow;
  text: string;
  hash: string;
};

/**
 * Bring one board up to date, creating its message when it has none and moving it to the end of
 * its thread when it is marked to relocate. A failed call is logged, and the next flush tries again.
 */
export async function publishBoard(options: PublishOptions): Promise<void> {
  const { workflow, row, text, hash } = options;
  if (row.message_id === null) {
    await createBoard(options);
    return;
  }
  if (row.relocate) return relocateBoard(options, row.message_id);
  if (row.hash === hash) return;
  try {
    await workflow.notifier.editBoard(row.channel, row.message_id, text);
    workflow.store.updateBoard(row.job_id, row.channel_key, { hash });
    workflow.log(null, `board of ${row.job_id} edited on ${row.channel_key}`);
  } catch (error) {
    await onEditFailure(options, error);
  }
}

/**
 * Create the message and point the row at it. A failure leaves the row as it was, so the next
 * flush creates it. Returns the new message id, or null when the create failed.
 */
async function createBoard(options: PublishOptions): Promise<string | null> {
  const { workflow, row, text, hash } = options;
  const { job_id: jobId, channel_key: key } = row;
  try {
    const messageId = await workflow.notifier.createBoard(row.channel, text);
    workflow.store.updateBoard(jobId, key, { message_id: messageId, hash, relocate: 0 });
    workflow.log(null, `board of ${jobId} created on ${key}`);
    return messageId;
  } catch (error) {
    workflow.log(null, `board of ${jobId} create failed on ${key}: ${String(error).slice(0, 200)}`);
    return null;
  }
}

/**
 * Post the board at the end of its thread, then delete the previous message. A previous message
 * that cannot be deleted is edited into a link to the new one. If that fails too it stays as is.
 */
async function relocateBoard(options: PublishOptions, previousId: string): Promise<void> {
  const { workflow, row } = options;
  const { job_id: jobId, channel_key: key } = row;
  const messageId = await createBoard(options);
  if (messageId === null) return;
  try {
    await workflow.notifier.deleteBoard(row.channel, previousId);
    workflow.log(null, `board of ${jobId} moved to the end of ${key}`);
    return;
  } catch (error) {
    workflow.log(
      null,
      `previous board of ${jobId} not deleted on ${key}: ${String(error).slice(0, 200)}`,
    );
  }
  try {
    const permalink = await workflow.notifier.boardPermalink(row.channel, messageId);
    await workflow.notifier.editBoard(row.channel, previousId, boardMovedText(permalink));
    workflow.log(null, `previous board of ${jobId} on ${key} now links to the new one`);
  } catch (error) {
    workflow.log(
      null,
      `previous board of ${jobId} on ${key} left as is: ${String(error).slice(0, 200)}`,
    );
  }
}

/**
 * An edit failed. A message someone deleted is re-created once, never twice. Any other
 * failure clears the hash, so the next flush writes the text again.
 */
async function onEditFailure(options: PublishOptions, error: unknown): Promise<void> {
  const { workflow, row } = options;
  const { job_id: jobId, channel_key: key } = row;
  if (!(await workflow.notifier.boardGone(row.channel, error))) {
    workflow.store.updateBoard(jobId, key, { hash: null });
    workflow.log(null, `board of ${jobId} edit failed on ${key}: ${String(error).slice(0, 200)}`);
    return;
  }
  if (row.recreated) {
    workflow.log(null, `board message of ${jobId} on ${key} is gone again. leaving it deleted.`);
    return;
  }
  workflow.log(null, `board message of ${jobId} on ${key} is gone. re-creating it once.`);
  const reset = { recreated: 1, message_id: null, hash: null };
  workflow.store.updateBoard(jobId, key, reset);
  await createBoard({ ...options, row: { ...row, ...reset } });
}
