import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { z } from "zod";
import { config } from "../config.js";
import { createChatModel, createEmbeddingModel, normalizeEmbeddingDimensions } from "../lib/gemini.js";
import { createSupabaseServiceClient } from "../lib/supabase.js";
import { KnowledgeRepository } from "../repositories/knowledge.js";

export type QueryMessage = {
  role: "user" | "assistant";
  content: string;
};

type SemanticMatch = Awaited<ReturnType<KnowledgeRepository["semanticSearch"]>>[number];

type QueryRunContext = {
  matches: SemanticMatch[];
};

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

function normalizeHistory(question: string, messages: QueryMessage[] = []) {
  const cleaned = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim()
    }))
    .filter((message) => message.content.length > 0);
  const lastMessage = cleaned.at(-1);

  if (lastMessage?.role === "user" && lastMessage.content === question.trim()) {
    return cleaned.slice(0, -1);
  }

  return cleaned;
}

function createQueryAgent(context: QueryRunContext) {
  const semanticSearch = tool(
    async ({ query, matchCount }) => {
      const repository = new KnowledgeRepository(createSupabaseServiceClient());
      const embeddings = createEmbeddingModel();
      const queryEmbedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(query));
      const matches = (await repository.semanticSearch(queryEmbedding, matchCount)).filter(
        (match) => match.similarity >= config.RAG_MIN_SIMILARITY
      );
      context.matches.push(...matches);
      return JSON.stringify(
        matches.map((match) => ({
          chunk_id: match.chunk_id,
          knowledge_item_id: match.knowledge_item_id,
          title: match.title,
          summary: match.summary,
          chunk_text: match.chunk_text,
          similarity: match.similarity
        }))
      );
    },
    {
      name: "semantic_search",
      description:
        "Search Kingshot wiki knowledge chunks by semantic similarity. " +
        "Input should be a focused search query, not necessarily the user's exact wording. " +
        "Returns JSON results with similarity scores, summaries, and chunk text. " +
        "If results are empty, too weak, or do not answer the user's intent, rewrite the query and call this tool again.",
      schema: z.object({
        query: z.string().describe("Focused search query for the Kingshot knowledge base."),
        matchCount: z.number().int().min(1).max(12).default(6)
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
      description: "List the fixed Kingshot wiki category taxonomy to help formulate better semantic_search queries.",
      schema: z.object({})
    }
  );

  return createAgent({
    model: createChatModel(),
    tools: [semanticSearch, listCategories],
    systemPrompt:
      "You are an agentic RAG assistant for Korean Kingshot(킹샷) game knowledge. " +
      "Use semantic_search only when the user asks for new Kingshot game knowledge, facts, strategy, data, or verification that is not already present in the conversation. " +
      "Do not search for greetings, small talk, app/help/meta questions, or requests to summarize, reorganize, shorten, translate, rephrase, or format information that is already present in the chat history. " +
      "When the needed answer is already in prior conversation messages, answer from that chat history without calling tools. " +
      "When you do search, inspect returned similarity scores, summaries, and chunk text. " +
      "If search results are empty, low-confidence, or not well aligned with the user's intent, rewrite the query and call semantic_search again. " +
      "Try up to three focused query variants when needed, including Korean synonyms, English game terms, category names, and narrower concepts. " +
      "For new knowledge questions, answer only from retrieved knowledge. If retrieval remains insufficient, say what is missing clearly. " +
      "Never rename Kingshot to another game title. Return concise Korean answers. Do not paste image URLs."
  });
}

function buildAgentMessages(question: string, messages: QueryMessage[] = []) {
  return [...normalizeHistory(question, messages), { role: "user" as const, content: question }];
}

async function buildMetadata(matches: SemanticMatch[]) {
  const sourceMap = new Map<string, SemanticMatch>();

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
  const repository = new KnowledgeRepository(createSupabaseServiceClient());
  const assets = await repository.getAssetsForItems(sources.map((source) => source.id));

  return {
    sources,
    images: assets.map((asset) => ({
      id: asset.id,
      url: asset.gcs_url,
      mimeType: asset.mime_type,
      knowledgeItemId: asset.knowledge_item_id
    }))
  };
}

export async function answerQuestion(question: string, messages: QueryMessage[] = []) {
  const context: QueryRunContext = { matches: [] };
  const result = await createQueryAgent(context).invoke({
    messages: buildAgentMessages(question, messages)
  });
  const metadata = await buildMetadata(context.matches);

  return {
    answer: extractAnswer(result),
    ...metadata
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

export async function* streamAnswerQuestion(
  question: string,
  messages: QueryMessage[] = [],
  signal?: AbortSignal
): AsyncGenerator<QueryStreamEvent> {
  const context: QueryRunContext = { matches: [] };
  const run = await createQueryAgent(context).streamEvents(
    {
      messages: buildAgentMessages(question, messages)
    },
    {
      version: "v3",
      signal
    }
  );

  for await (const message of run.messages) {
    if (message.node !== "model_request") continue;
    for await (const token of message.text) {
      if (token) {
        yield { type: "text", delta: token };
      }
    }
  }

  const metadata = await buildMetadata(context.matches);
  yield { type: "metadata", ...metadata };
  yield { type: "done" };
}
