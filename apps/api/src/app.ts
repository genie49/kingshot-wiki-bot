import { cors } from "hono/cors";
import { Hono } from "hono";
import { config } from "./config.js";
import { uploadImageToGcs } from "./lib/gcs.js";
import { createSupabaseServiceClient } from "./lib/supabase.js";
import { KnowledgeRepository } from "./repositories/knowledge.js";
import { answerQuestion, streamAnswerQuestion } from "./services/queryAgent.js";
import { ingestKnowledge, ingestRequestSchema } from "./services/ingestion.js";

export const app = new Hono();

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: error.message || "Internal server error" }, 500);
});

app.use(
  "*",
  cors({
    origin: config.CORS_ORIGIN,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"]
  })
);

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "kingshot-wiki-bot-api"
  })
);

function createKnowledgeRepository() {
  return new KnowledgeRepository(createSupabaseServiceClient());
}

app.get("/categories", async (c) => {
  const categories = await createKnowledgeRepository().listCategories();
  return c.json({ categories });
});

app.get("/knowledge", async (c) => {
  const status = c.req.query("status");
  const limit = Number(c.req.query("limit") ?? 50);
  const items = await createKnowledgeRepository().listKnowledgeItems({
    status: status || undefined,
    limit: Number.isFinite(limit) ? limit : 50
  });
  return c.json({ items });
});

app.get("/knowledge/:id", async (c) => {
  const item = await createKnowledgeRepository().getKnowledgeItem(c.req.param("id"));
  return c.json({ item });
});

app.patch("/knowledge/:id", async (c) => {
  const payload = await c.req.json<{
    title?: string;
    summary?: string;
    body?: string;
    categoryId?: string | null;
    tags?: string[];
    sourceType?: "ai" | "swalove";
    sourceNote?: string | null;
    status?: "draft" | "published" | "needs_review";
  }>();
  const item = await createKnowledgeRepository().updateKnowledgeItem(c.req.param("id"), payload);
  return c.json({ item });
});

app.delete("/knowledge/:id", async (c) => {
  const item = await createKnowledgeRepository().deleteKnowledgeItem(c.req.param("id"));
  return c.json({ item });
});

app.post("/ingest", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const body = String(form.get("body") ?? "");
    const sourceType = form.get("sourceType");
    const sourceNote = form.get("sourceNote");
    const files = form
      .getAll("images")
      .filter((value): value is File => value instanceof File);
    const uploadedAssets = await Promise.all(files.map((file) => uploadImageToGcs(file)));
    const result = await ingestKnowledge({
      body,
      sourceType: sourceType === "swalove" ? "swalove" : "ai",
      sourceNote: typeof sourceNote === "string" ? sourceNote : undefined,
      assets: uploadedAssets.map((asset) => ({
        url: asset.url,
        mimeType: asset.mimeType
      })),
      imageUrls: []
    });

    return c.json({ ...result, uploadedAssets }, 202);
  }

  const payload = ingestRequestSchema.parse(await c.req.json());
  const result = await ingestKnowledge(payload);
  return c.json(result, 202);
});

app.post("/query", async (c) => {
  const payload = await c.req.json<{
    question?: string;
    messages?: { role: "user" | "assistant"; content: string }[];
  }>();
  if (!payload.question) {
    return c.json({ error: "question is required" }, 400);
  }

  const result = await answerQuestion(payload.question, payload.messages ?? []);
  return c.json(result);
});

function encodeSse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

app.post("/query/stream", async (c) => {
  const payload = await c.req.json<{
    question?: string;
    messages?: { role: "user" | "assistant"; content: string }[];
  }>();
  if (!payload.question) {
    return c.json({ error: "question is required" }, 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of streamAnswerQuestion(payload.question!, payload.messages ?? [], c.req.raw.signal)) {
          controller.enqueue(encoder.encode(encodeSse(event.type, event)));
        }
      } catch (error) {
        if (!c.req.raw.signal.aborted) {
          const message = error instanceof Error ? error.message : "Streaming failed";
          controller.enqueue(encoder.encode(encodeSse("error", { type: "error", error: message })));
        }
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
});

export default app;
