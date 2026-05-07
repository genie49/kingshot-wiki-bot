import { setupPostgresCheckpointer } from "../lib/langgraphPersistence.js";

await setupPostgresCheckpointer();
console.log("LangGraph Postgres checkpointer is ready.");
