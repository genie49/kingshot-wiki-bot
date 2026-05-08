import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { z } from "zod";
import { config } from "../config.js";
import { createChatModel, createEmbeddingModel, normalizeEmbeddingDimensions } from "../lib/llm.js";
import { createSupabaseServiceClient } from "../lib/supabase.js";
import { GlossaryRepository } from "../repositories/glossary.js";
import { KnowledgeRepository } from "../repositories/knowledge.js";

export type QueryMessage = {
  role: "user" | "assistant";
  content: string;
};

type SemanticMatch = Awaited<ReturnType<KnowledgeRepository["semanticSearch"]>>[number];

type TrackedSource = {
  sourceId: string;
  kind: "rag" | "reddit";
  title: string;
  summary: string;
  url?: string;
  similarity?: number;
  knowledgeItemId?: string;
};

type QueryRunContext = {
  matches: SemanticMatch[];
  trackedSources: TrackedSource[];
  redditSources: { title: string; url: string; snippet: string; score: number }[];
};

const TOOL_LABELS: Record<string, string> = {
  semantic_search: "데이터베이스 검색",
  glossary_translate: "한/영 사전 검색",
  reddit_search: "Reddit 검색"
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
  let ragCounter = 0;
  let redditCounter = 0;

  const semanticSearch = tool(
    async ({ query, matchCount }) => {
      const repository = new KnowledgeRepository(createSupabaseServiceClient());
      const embeddings = createEmbeddingModel();
      const queryEmbedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(query));
      const matches = (await repository.semanticSearch(queryEmbedding, matchCount)).filter(
        (match) => match.similarity >= config.RAG_MIN_SIMILARITY
      );
      context.matches.push(...matches);
      const mapped = matches.map((match) => {
        ragCounter++;
        const sourceId = `rag-${ragCounter}`;
        context.trackedSources.push({
          sourceId,
          kind: "rag",
          title: match.title,
          summary: match.summary,
          similarity: match.similarity,
          knowledgeItemId: match.knowledge_item_id
        });
        return { sourceId, chunk_id: match.chunk_id, knowledge_item_id: match.knowledge_item_id, title: match.title, summary: match.summary, chunk_text: match.chunk_text, similarity: match.similarity };
      });
      return JSON.stringify(mapped);
    },
    {
      name: "semantic_search",
      description:
        "Search Kingshot wiki knowledge chunks by semantic similarity. " +
        "Input should be a focused search query, not necessarily the user's exact wording. " +
        "Returns JSON results with similarity scores, summaries, and chunk text. Each result has a sourceId. " +
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

  const redditSearch = tool(
    async ({ query, subreddit, sort }) => {
      const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
      const sub = subreddit || "Kingshot";
      const sortParam = sort || "relevance";
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=${sortParam}&limit=10`;
      const res = await fetch(url, { headers: { "User-Agent": ua } });
      if (!res.ok) return JSON.stringify({ error: `Reddit API returned ${res.status}` });
      const body = await res.json() as { data?: { children?: { data: { title: string; author: string; score: number; selftext: string; num_comments: number; permalink: string; created_utc: number } }[] } };
      const posts = (body.data?.children ?? []).map((child) => {
        const d = child.data;
        redditCounter++;
        const sourceId = `reddit-${redditCounter}`;
        const redditUrl = `https://www.reddit.com${d.permalink}`;
        context.trackedSources.push({
          sourceId,
          kind: "reddit",
          title: d.title,
          summary: d.selftext?.slice(0, 200) ?? "",
          url: redditUrl
        });
        context.redditSources.push({ title: d.title, url: redditUrl, snippet: d.selftext?.slice(0, 300) ?? "", score: d.score });
        return { sourceId, title: d.title, author: d.author, score: d.score, comments: d.num_comments, snippet: d.selftext?.slice(0, 300) ?? "", url: redditUrl, created: new Date(d.created_utc * 1000).toISOString() };
      });
      return JSON.stringify(posts);
    },
    {
      name: "reddit_search",
      description:
        "Search Reddit posts in a subreddit. Returns post titles, scores, comment counts, text snippets, and URLs. Each result has a sourceId. " +
        "Use when the user asks about community opinions, discussions, guides, or tips from Reddit. " +
        "Defaults to r/Kingshot sorted by relevance.",
      schema: z.object({
        query: z.string().describe("Search query for Reddit posts."),
        subreddit: z.string().optional().describe("Subreddit name without r/. Defaults to Kingshot."),
        sort: z.enum(["relevance", "hot", "top", "new", "comments"]).optional().describe("Sort order. Defaults to relevance.")
      })
    }
  );

  const glossaryTranslate = tool(
    async ({ query, matchCount }) => {
      const repository = new GlossaryRepository(createSupabaseServiceClient());
      const embeddings = createEmbeddingModel();
      const queryEmbedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(query));
      const matches = await repository.searchSimilar(queryEmbedding, matchCount);
      return JSON.stringify(
        matches.map((match) => ({
          ko: match.canonical_ko,
          en: match.canonical_en,
          category: match.category,
          similarity: match.similarity
        }))
      );
    },
    {
      name: "glossary_translate",
      description:
        "Look up canonical Korean↔English Kingshot terminology (hero names, building names, troop types, stat labels, in-game resources, UI terms). " +
        "Call this BEFORE semantic_search whenever the user mentions a Kingshot game-specific noun or jargon, in either language. " +
        "Use the returned `ko` and `en` strings together as keywords in the next semantic_search call so retrieval reaches both Korean and English knowledge chunks. " +
        "Returns an array of {ko, en, category, similarity} sorted by relevance.",
      schema: z.object({
        query: z
          .string()
          .describe("A short phrase or single term you want to translate or normalize. Use the user's wording."),
        matchCount: z.number().int().min(1).max(15).default(6)
      })
    }
  );

  return createAgent({
    model: createChatModel(),
    tools: [glossaryTranslate, semanticSearch, listCategories, redditSearch],
    systemPrompt:
      "You are an agentic RAG assistant for Korean Kingshot(킹샷) game knowledge. " +
      "The knowledge base mixes Korean and English chunks, and the embedding model often fails to bridge the two. " +
      "When the user mentions a Kingshot game-specific noun (hero, building, troop type, stat, resource, event, etc.) in either language, FIRST call glossary_translate with that term to fetch the canonical Korean↔English pair, then call semantic_search with a query that contains BOTH the Korean and English forms (and any close aliases the glossary returned). " +
      "Skip glossary_translate only when the user is plainly asking about generic concepts that have no Kingshot-specific term. " +
      "Use semantic_search only when the user asks for new Kingshot game knowledge, facts, strategy, data, or verification that is not already present in the conversation. " +
      "Do not search for greetings, small talk, app/help/meta questions, or requests to summarize, reorganize, shorten, translate, rephrase, or format information that is already present in the chat history. " +
      "When the needed answer is already in prior conversation messages, answer from that chat history without calling tools. " +
      "When you do search, inspect returned similarity scores, summaries, and chunk text. " +
      "If search results are empty, low-confidence, or not well aligned with the user's intent, rewrite the query (try the other language, broader terms, or category names) and call semantic_search again. " +
      "Try up to three focused query variants when needed. " +
      "When the knowledge base does not have enough information, or the user explicitly asks about community discussions, opinions, or Reddit content, use reddit_search to find relevant Reddit posts. " +
      "For new knowledge questions, answer only from retrieved knowledge. If retrieval remains insufficient or no relevant results are found after all attempts, respond exactly: '검색 결과에서 해당 정보를 찾을 수 없습니다.' and briefly suggest the user try different keywords. " +
      "Never rename Kingshot to another game title. Return concise Korean answers. Do not paste image URLs."
  });
}

function buildAgentMessages(question: string, messages: QueryMessage[] = []) {
  return [...normalizeHistory(question, messages), { role: "user" as const, content: question }];
}

export type SourceInfo = {
  sourceId: string;
  kind: "rag" | "reddit";
  title: string;
  summary: string;
  url?: string;
  similarity?: number;
  knowledgeItemId?: string;
};

export type QueryStreamEvent =
  | { type: "tool_start"; tool: string; label: string }
  | { type: "tool_end"; tool: string }
  | { type: "text"; delta: string }
  | { type: "metadata"; sources: SourceInfo[] }
  | { type: "done" };

export async function* streamAnswerQuestion(
  question: string,
  messages: QueryMessage[] = [],
  signal?: AbortSignal
): AsyncGenerator<QueryStreamEvent> {
  const context: QueryRunContext = { matches: [], trackedSources: [], redditSources: [] };
  const agent = createQueryAgent(context);
  const run = await agent.streamEvents(
    {
      messages: buildAgentMessages(question, messages)
    },
    {
      version: "v3",
      signal
    }
  );

  let completeAnswer = "";
  for await (const rawEvent of run) {
    const event = rawEvent as any;
    if (event.event === "on_tool_start") {
      const toolName = event.name;
      console.log(`[Tool Start] ${toolName}`, JSON.stringify(event.data?.input));
      const label = TOOL_LABELS[toolName];
      if (label) {
        yield { type: "tool_start", tool: toolName, label };
      }
    }
    if (event.event === "on_tool_end") {
      const toolName = event.name;
      console.log(`[Tool End] ${toolName}`, JSON.stringify(event.data?.output)?.substring(0, 200) + '...');
      const label = TOOL_LABELS[toolName];
      if (label) {
        yield { type: "tool_end", tool: toolName };
      }
    }
    if (event.event === "on_chat_model_stream") {
      const chunk = event.data?.chunk;
      if (chunk?.content && typeof chunk.content === "string") {
        completeAnswer += chunk.content;
        yield { type: "text", delta: chunk.content };
      } else if (Array.isArray(chunk?.content)) {
        for (const block of chunk.content) {
          if (typeof block === "string" && block) {
            completeAnswer += block;
            yield { type: "text", delta: block };
          } else if (block && typeof block === "object" && "text" in block && block.text) {
            completeAnswer += block.text;
            yield { type: "text", delta: block.text };
          }
        }
      }
    }
  }

  let citedSourceIds: string[] = [];
  if (context.trackedSources.length > 0 && completeAnswer.trim().length > 0) {
    console.log(`[Citation Extraction] Starting extraction for ${context.trackedSources.length} sources...`);
    const citationModel = createChatModel().withStructuredOutput(
      z.object({
        citedSourceIds: z.array(z.string()).describe("Array of sourceIds that were actually used or referenced in the assistant's answer.")
      }),
      { name: "extract_citations" }
    );
    
    const sourcesText = context.trackedSources
      .map((s) => `[${s.sourceId}] ${s.title}\n${s.summary}`)
      .join("\n\n");
      
    const extractionPrompt = `You are a citation extraction assistant.
Look at the following assistant's answer and the list of available sources.
Determine which sources were actually used or referenced to write the answer.
Return a JSON object containing the array of cited sourceIds. If none were used, return an empty array.

Available Sources:
${sourcesText}

Assistant's Answer:
${completeAnswer}`;

    try {
      const result = await citationModel.invoke(extractionPrompt);
      citedSourceIds = result.citedSourceIds || [];
      console.log(`[Citation Extraction] Extracted IDs:`, citedSourceIds);
    } catch (err) {
      console.error(`[Citation Extraction] Failed:`, err);
      citedSourceIds = context.trackedSources.map((s) => s.sourceId);
    }
  }

  const citedSet = new Set(citedSourceIds);
  const citedSources = context.trackedSources.filter((s) => citedSet.has(s.sourceId));
  yield { type: "metadata", sources: citedSources };
  yield { type: "done" };
}

export async function answerQuestion(question: string, messages: QueryMessage[] = []) {
  const collected: QueryStreamEvent[] = [];
  for await (const event of streamAnswerQuestion(question, messages)) {
    collected.push(event);
  }
  const textParts = collected
    .filter((e): e is { type: "text"; delta: string } => e.type === "text")
    .map((e) => e.delta);
  const metadata = collected.find((e): e is { type: "metadata"; sources: SourceInfo[] } => e.type === "metadata");

  return {
    answer: textParts.join(""),
    sources: metadata?.sources ?? []
  };
}
