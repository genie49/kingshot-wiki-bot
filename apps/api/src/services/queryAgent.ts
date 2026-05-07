import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { z } from "zod";
import { config } from "../config.js";
import { createChatModel, createEmbeddingModel, normalizeEmbeddingDimensions } from "../lib/gemini.js";
import { createSupabaseServiceClient } from "../lib/supabase.js";
import { KnowledgeRepository } from "../repositories/knowledge.js";

const semanticSearch = tool(
  async ({ query, matchCount }) => {
    const repository = new KnowledgeRepository(createSupabaseServiceClient());
    const embeddings = createEmbeddingModel();
    const queryEmbedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(query));
    const matches = (await repository.semanticSearch(queryEmbedding, matchCount)).filter(
      (match) => match.similarity >= config.RAG_MIN_SIMILARITY
    );
    return JSON.stringify(matches);
  },
  {
    name: "semantic_search",
    description: "Search Kingshot knowledge chunks by semantic similarity.",
    schema: z.object({
      query: z.string(),
      matchCount: z.number().int().min(1).max(12).default(6)
    })
  }
);

const getRelatedImages = tool(
  async ({ knowledgeItemIds }) => {
    const repository = new KnowledgeRepository(createSupabaseServiceClient());
    const assets = await repository.getAssetsForItems(knowledgeItemIds);
    return JSON.stringify(assets);
  },
  {
    name: "get_related_images",
    description: "Fetch image assets related to one or more knowledge item IDs.",
    schema: z.object({
      knowledgeItemIds: z.array(z.string()).max(12)
    })
  }
);

const listCategories = tool(
  async () => {
    const repository = new KnowledgeRepository(createSupabaseServiceClient());
    return JSON.stringify(await repository.listCategories());
  },
  {
    name: "list_categories",
    description: "List the fixed Kingshot wiki category taxonomy.",
    schema: z.object({})
  }
);

let queryAgent: ReturnType<typeof createAgent> | undefined;

function getQueryAgent() {
  queryAgent ??= createAgent({
    model: createChatModel(),
    tools: [semanticSearch, getRelatedImages, listCategories],
    systemPrompt:
      "You answer Korean Kingshot(킹샷) game questions using only retrieved knowledge. " +
      "Never rename Kingshot to another game title. " +
      "Search first, fetch related images when useful, and be explicit when the knowledge base is missing details. " +
      "Return concise Korean answers. Do not paste image URLs in the answer text; the API returns related images separately."
  });

  return queryAgent;
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (block && typeof block === "object" && "text" in block) {
          return String(block.text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function extractAnswer(result: Awaited<ReturnType<ReturnType<typeof createAgent>["invoke"]>>) {
  if ("content" in result) {
    const content = stringifyContent(result.content);
    if (content) return content;
  }

  const messages = "messages" in result && Array.isArray(result.messages) ? result.messages : [];
  for (const message of [...messages].reverse()) {
    const content = stringifyContent(message.content);
    if (content) return content;
  }

  return "";
}

function buildRagPrompt(question: string, matches: Awaited<ReturnType<KnowledgeRepository["semanticSearch"]>>) {
  const context = matches.length
    ? matches
        .map(
          (match, index) =>
            `[${index + 1}] ${match.title}\n요약: ${match.summary}\n본문: ${match.chunk_text}\n유사도: ${match.similarity.toFixed(3)}`
        )
        .join("\n\n")
    : "검색 기준을 넘는 지식이 없습니다.";

  return [
    {
      role: "system" as const,
      content:
        "You answer Korean Kingshot(킹샷) game questions using only the provided retrieved knowledge. " +
        "Never rename Kingshot to another game title. " +
        "If the retrieved knowledge is missing details, say that clearly. " +
        "Return concise Korean answers. Do not paste image URLs."
    },
    {
      role: "user" as const,
      content: `질문:\n${question}\n\n검색된 지식:\n${context}`
    }
  ];
}

export async function answerQuestion(question: string) {
  const repository = new KnowledgeRepository(createSupabaseServiceClient());
  const embeddings = createEmbeddingModel();
  const queryEmbedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(question));
  const matches = (await repository.semanticSearch(queryEmbedding, 6)).filter(
    (match) => match.similarity >= config.RAG_MIN_SIMILARITY
  );
  const sourceMap = new Map<string, (typeof matches)[number]>();

  for (const match of matches) {
    const existing = sourceMap.get(match.knowledge_item_id);
    if (!existing || match.similarity > existing.similarity) {
      sourceMap.set(match.knowledge_item_id, match);
    }
  }

  const sources = Array.from(sourceMap.values()).map((match) => ({
    id: match.knowledge_item_id,
    title: match.title,
    summary: match.summary,
    similarity: match.similarity
  }));
  const assets = await repository.getAssetsForItems(sources.map((source) => source.id));
  const result = await getQueryAgent().invoke({
    messages: [{ role: "user", content: question }]
  });

  return {
    answer: extractAnswer(result),
    sources,
    images: assets.map((asset) => ({
      id: asset.id,
      url: asset.gcs_url,
      mimeType: asset.mime_type,
      knowledgeItemId: asset.knowledge_item_id
    }))
  };
}

export type QueryStreamEvent =
  | {
      type: "metadata";
      sources: Awaited<ReturnType<typeof answerQuestion>>["sources"];
      images: Awaited<ReturnType<typeof answerQuestion>>["images"];
    }
  | { type: "text"; delta: string }
  | { type: "done" };

export async function* streamAnswerQuestion(question: string, signal?: AbortSignal): AsyncGenerator<QueryStreamEvent> {
  const repository = new KnowledgeRepository(createSupabaseServiceClient());
  const embeddings = createEmbeddingModel();
  const queryEmbedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(question));
  const matches = (await repository.semanticSearch(queryEmbedding, 6)).filter(
    (match) => match.similarity >= config.RAG_MIN_SIMILARITY
  );
  const sourceMap = new Map<string, (typeof matches)[number]>();

  for (const match of matches) {
    const existing = sourceMap.get(match.knowledge_item_id);
    if (!existing || match.similarity > existing.similarity) {
      sourceMap.set(match.knowledge_item_id, match);
    }
  }

  const sources = Array.from(sourceMap.values()).map((match) => ({
    id: match.knowledge_item_id,
    title: match.title,
    summary: match.summary,
    similarity: match.similarity
  }));
  const assets = await repository.getAssetsForItems(sources.map((source) => source.id));
  const images = assets.map((asset) => ({
    id: asset.id,
    url: asset.gcs_url,
    mimeType: asset.mime_type,
    knowledgeItemId: asset.knowledge_item_id
  }));

  yield { type: "metadata", sources, images };

  const stream = await createChatModel().stream(buildRagPrompt(question, matches), { signal });
  for await (const chunk of stream) {
    const text = stringifyContent(chunk.content);
    if (text) {
      yield { type: "text", delta: text };
    }
  }

  yield { type: "done" };
}
