import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { requireConfig } from "../config.js";

let checkpointer: PostgresSaver | undefined;
let setupPromise: Promise<void> | undefined;

export function createPostgresCheckpointer() {
  checkpointer ??= PostgresSaver.fromConnString(requireConfig("POSTGRES_CHECKPOINT_URL"));
  return checkpointer;
}

export async function setupPostgresCheckpointer() {
  const saver = createPostgresCheckpointer();
  setupPromise ??= saver.setup();
  await setupPromise;
  return saver;
}
