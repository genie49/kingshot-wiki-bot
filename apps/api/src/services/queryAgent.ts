import { tool } from "@langchain/core/tools";
import { createAgent } from "langchain";
import { z } from "zod";
import { config } from "../config.js";
import { createChatModel, createEmbeddingModel, createMainAgentChatModel, normalizeEmbeddingDimensions } from "../lib/llm.js";
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
    async ({ query, subreddit, sort, postLimit }) => {
      const ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
      const sub = subreddit || "Kingshot";
      const sortParam = sort || "relevance";
      const maxPosts = Math.min(Math.max(postLimit ?? 5, 1), 10);
      const url = `https://www.reddit.com/r/${sub}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=${sortParam}&limit=${maxPosts}`;
      const res = await fetch(url, { headers: { "User-Agent": ua } });
      if (!res.ok) return JSON.stringify({ error: `Reddit API returned ${res.status}` });
      const body = await res.json() as { data?: { children?: { data: { title: string; author: string; score: number; selftext: string; num_comments: number; permalink: string; created_utc: number } }[] } };
      const children = (body.data?.children ?? []).slice(0, maxPosts);

      type CommentNode = {
        kind?: string;
        data?: {
          author?: string;
          body?: string;
          score?: number;
          depth?: number;
          stickied?: boolean;
          replies?: string | { data?: { children?: CommentNode[] } };
        };
      };
      type FlatComment = { author: string; body: string; score: number; depth: number };

      function flattenComments(nodes: CommentNode[] | undefined, depth: number, out: FlatComment[]) {
        if (!nodes) return;
        for (const node of nodes) {
          if (node.kind !== "t1") continue;
          const d = node.data;
          if (!d) continue;
          if (typeof d.body === "string" && d.body.length > 0) {
            out.push({
              author: d.author ?? "",
              body: d.body,
              score: d.score ?? 0,
              depth: typeof d.depth === "number" ? d.depth : depth
            });
          }
          const replies = d.replies;
          if (replies && typeof replies === "object" && replies.data?.children) {
            flattenComments(replies.data.children, depth + 1, out);
          }
        }
      }

      async function fetchAllComments(permalink: string): Promise<FlatComment[]> {
        try {
          const cUrl = `https://www.reddit.com${permalink}.json?limit=500&sort=top`;
          const cRes = await fetch(cUrl, { headers: { "User-Agent": ua } });
          if (!cRes.ok) return [];
          const json = await cRes.json() as Array<{ data?: { children?: CommentNode[] } }>;
          const commentListing = json[1];
          const flat: FlatComment[] = [];
          flattenComments(commentListing?.data?.children, 0, flat);
          return flat;
        } catch {
          return [];
        }
      }

      const posts = await Promise.all(children.map(async (child) => {
        const d = child.data;
        redditCounter++;
        const sourceId = `reddit-${redditCounter}`;
        const redditUrl = `https://www.reddit.com${d.permalink}`;
        const comments = await fetchAllComments(d.permalink);
        const commentDigest = comments.length > 0
          ? "\n\n[Comments]\n" + comments.map((c) => `${"  ".repeat(c.depth)}- (${c.score}) ${c.author}: ${c.body}`).join("\n")
          : "";
        context.trackedSources.push({
          sourceId,
          kind: "reddit",
          title: d.title,
          summary: ((d.selftext ?? "") + commentDigest).slice(0, 1200),
          url: redditUrl
        });
        context.redditSources.push({ title: d.title, url: redditUrl, snippet: d.selftext?.slice(0, 500) ?? "", score: d.score });
        return {
          sourceId,
          title: d.title,
          author: d.author,
          score: d.score,
          num_comments: d.num_comments,
          selftext: d.selftext ?? "",
          url: redditUrl,
          created: new Date(d.created_utc * 1000).toISOString(),
          comments
        };
      }));
      return JSON.stringify(posts);
    },
    {
      name: "reddit_search",
      description:
        "Search Reddit posts in a subreddit AND scrape the ENTIRE comment tree of each result (all depths, all branches). " +
        "Returns post title, author, score, full selftext, URL, and the complete flattened comment list (each comment has author, body, score, depth). Each post has a sourceId. " +
        "Reddit comments often contain richer information than the post body itself, so use them as the primary source for community opinions, strategy debates, tips, and meta consensus. " +
        "Defaults to r/Kingshot sorted by relevance, fetching top 5 posts with their full comment trees.",
      schema: z.object({
        query: z.string().describe("Search query for Reddit posts."),
        subreddit: z.string().optional().describe("Subreddit name without r/. Defaults to Kingshot."),
        sort: z.enum(["relevance", "hot", "top", "new", "comments"]).optional().describe("Sort order. Defaults to relevance."),
        postLimit: z.number().int().min(1).max(10).optional().describe("Max posts to fetch. Defaults to 5.")
      })
    }
  );

  const glossaryTranslate = tool(
    async ({ query, matchCount }) => {
      const repository = new GlossaryRepository(createSupabaseServiceClient());
      const embeddings = createEmbeddingModel();
      const queryEmbedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(query));
      const matches = await repository.searchSimilar(queryEmbedding, matchCount);
      if (matches.length === 0) {
        return JSON.stringify({
          status: "no_match",
          query,
          note: "No canonical glossary entry found. Do NOT call glossary_translate with this query again. Proceed directly to semantic_search using the user's original wording."
        });
      }
      return JSON.stringify({
        status: "ok",
        matches: matches.map((match) => ({
          ko: match.canonical_ko,
          en: match.canonical_en,
          category: match.category,
          similarity: match.similarity
        }))
      });
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
    model: createMainAgentChatModel(),
    tools: [glossaryTranslate, semanticSearch, listCategories, redditSearch],
    systemPrompt:
      "You are an agentic RAG assistant for Korean Kingshot(킹샷) game knowledge. " +
      "The knowledge base mixes Korean and English chunks, and the embedding model often fails to bridge the two. " +
      "\n\n## PRIMARY DIRECTIVE — answer in a single turn\n" +
      "Your job is to deliver the MOST COMPLETE, DECISIVE answer in ONE response. The user asks once; you must finish the research and produce a concrete conclusion before responding. " +
      "NEVER end with prompts like '추가로 더 자세한 정보가 필요하시면 알려주세요', '더 자세한 커뮤니티 의견이 필요하시면 알려주세요', '원하시면 더 찾아드릴까요?' — these are forbidden. The user does not want to ask twice. " +
      "If the question contains a comparison or a choice (e.g. 'A vs B', '~게 나은가 아니면 ~게 나은가'), you MUST take a definitive side and explain why, based on retrieved evidence. Do NOT punt with '구체적인 결론이 나오지 않았습니다'. Pick the most-supported option.\n\n" +
      "## Tool escalation chain (MANDATORY for new-knowledge questions)\n" +
      "Step 1 — glossary_translate (optional): If the user mentions a Kingshot game-specific noun (hero, building, troop type, stat, resource, event, etc.) in either language, call glossary_translate ONCE with that term to fetch the canonical Korean↔English pair. Skip this step entirely for generic concepts. " +
      "If glossary_translate returns status=\"no_match\" or an empty list, do NOT call it again with any rewording — move on to Step 2.\n" +
      "Step 2 — semantic_search: Run semantic_search with a query that contains BOTH Korean and English forms (use glossary results if Step 1 succeeded; otherwise use the user's wording). Inspect similarity scores, summaries, and chunk text. " +
      "If the first semantic_search returns empty, low-confidence, or off-topic results, you MAY rewrite ONCE and retry. After at most 2 semantic_search attempts, move on to Step 3.\n" +
      "Step 3 — reddit_search (MANDATORY whenever the question involves player choice, strategy, opinion, meta, tier comparisons, or 'is X better than Y'): " +
      "Reddit is the AUTHORITATIVE source for this game's community consensus. You MUST call reddit_search at least 2 times — and up to 4 times — with DIFFERENT query variations (broader English terms, event names, mechanic names, synonyms, in-game item names) until you have collected enough community evidence to take a side. " +
      "Each reddit_search returns the FULL comment trees of top posts; READ THE COMMENTS, not just titles. Comments contain the actual veteran consensus, refresh-vs-open debates, hammer/key economy, and meta opinions. " +
      "Do not skip Step 3 just because Step 2 surfaced something — DB chunks are usually wiki-style and rarely answer 'which is better' questions. Comments are.\n\n" +
      "## How to decide and answer\n" +
      "After running the tools, synthesize: count how many comments/posts lean each way, weigh by upvotes, and STATE THE WINNING SIDE PLAINLY in the first sentence. Then justify with 2–4 bullet points referencing the community reasoning (don't just paraphrase one comment). " +
      "If after Steps 2 and 3 the evidence is genuinely split or inconclusive, say so explicitly with the trade-offs of each option (still a complete answer — not a deferral). " +
      "Only if reddit_search ALSO yielded zero relevant posts/comments after 2+ attempts, respond exactly: '검색 결과에서 해당 정보를 찾을 수 없습니다.' and briefly suggest different keywords. This is the ONLY allowed deflection.\n\n" +
      "## When NOT to search\n" +
      "Do not call any tool for greetings, small talk, app/help/meta questions, or requests to summarize, reorganize, shorten, translate, rephrase, or format information already present in the chat history. Answer directly from history when possible.\n\n" +
      "## General rules\n" +
      "- Never call the same tool with the same arguments twice in a row.\n" +
      "- Always escalate down the chain (glossary_translate → semantic_search → reddit_search) on weak results; do not loop on a single tool.\n" +
      "- Answer ONLY from retrieved knowledge (DB chunks or Reddit posts/comments). Do not invent facts.\n" +
      "- Never rename Kingshot to another game title. Return concise Korean answers. Do not paste image URLs."
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
  images?: { id: string; url: string; mimeType: string }[];
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
  const pendingTools = new Set<string>(); // track tool names currently executing
  for await (const rawEvent of run) {
    const ev = rawEvent as any;

    // v3 events: { type: "event", method: "messages"|"tasks"|"lifecycle"|"updates"|..., params: { data, node? } }
    if (ev.type !== "event") continue;
    const method = ev.method;
    const data = ev.params?.data;
    const node = ev.params?.node;

    // ── Text streaming via "messages" method (only from model_request node) ──
    if (method === "messages" && data && node === "model_request") {
      if (data.event === "content-block-delta" && data.delta?.type === "text-delta" && data.delta.text) {
        completeAnswer += data.delta.text;
        yield { type: "text", delta: data.delta.text };
      }
    }

    // ── Tool start: detect from model_request task result (AIMessage with tool_calls) ──
    if (method === "tasks" && data?.name === "model_request" && data.result) {
      try {
        const msgs = data.result?.messages;
        if (Array.isArray(msgs)) {
          for (const msg of msgs) {
            const toolCalls = msg?.tool_calls;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                const toolName = tc.name;
                const label = TOOL_LABELS[toolName];
                if (label && !pendingTools.has(toolName)) {
                  pendingTools.add(toolName);
                  console.log(`[Tool Start] ${toolName}`, JSON.stringify(tc.args).substring(0, 200));
                  yield { type: "tool_start", tool: toolName, label };
                }
              }
            }
          }
        }
      } catch { /* ignore parse issues */ }
    }

    // ── Tool end: detect from "updates" method when node === "tools" ──
    if (method === "updates" && node === "tools" && data?.values) {
      try {
        const msgs = data.values?.messages;
        if (Array.isArray(msgs)) {
          for (const msg of msgs) {
            const toolName = msg?.name;
            const label = TOOL_LABELS[toolName];
            if (label && pendingTools.has(toolName)) {
              pendingTools.delete(toolName);
              const content = msg?.content;
              console.log(`[Tool End] ${toolName}`, String(content).substring(0, 200));
              yield { type: "tool_end", tool: toolName };
            }
          }
        }
      } catch { /* ignore parse issues */ }
    }

    // ── Lifecycle logging ──
    if (method === "lifecycle" && data) {
      console.log(`[Lifecycle] ${data.event} (${data.graph_name})`);
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
      
    const historyText = messages
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");
      
    const extractionPrompt = `You are a citation extraction assistant.
Look at the following assistant's answer, the conversation history, and the list of available sources.
Determine which sources were actually used or referenced to write the final answer.
Return a JSON object containing the array of cited sourceIds. If none were used, return an empty array.

Conversation History:
${historyText || "No previous history."}

Current Question:
User: ${question}

Available Sources:
${sourcesText}

Assistant's Final Answer:
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
  const citedSourcesRaw = context.trackedSources.filter((s) => citedSet.has(s.sourceId));
  
  // Deduplicate sources
  const citedSources: SourceInfo[] = [];
  const seenIds = new Set<string>();
  for (const s of citedSourcesRaw) {
    const dedupKey = s.kind === "rag" ? s.knowledgeItemId : s.url;
    if (dedupKey) {
      if (seenIds.has(dedupKey)) continue;
      seenIds.add(dedupKey);
    }
    citedSources.push(s);
  }

  // Fetch images for cited RAG sources
  const ragItemIds = citedSources
    .filter((s) => s.kind === "rag" && s.knowledgeItemId)
    .map((s) => s.knowledgeItemId!);
  if (ragItemIds.length > 0) {
    try {
      const uniqueIds = [...new Set(ragItemIds)];
      const repository = new KnowledgeRepository(createSupabaseServiceClient());
      const assets = await repository.getAssetsForItems(uniqueIds);
      console.log(`[Images] Found ${assets.length} assets for ${uniqueIds.length} cited items`);
      const assetsByItem = new Map<string, typeof assets>();
      for (const asset of assets) {
        const list = assetsByItem.get(asset.knowledge_item_id) || [];
        list.push(asset);
        assetsByItem.set(asset.knowledge_item_id, list);
      }
      for (const source of citedSources) {
        if (source.kind === "rag" && source.knowledgeItemId) {
          const itemAssets = assetsByItem.get(source.knowledgeItemId);
          if (itemAssets && itemAssets.length > 0) {
            source.images = itemAssets
              .filter((a) => a.mime_type.startsWith("image/"))
              .map((a) => ({ id: a.id, url: a.gcs_url, mimeType: a.mime_type }));
          }
        }
      }
    } catch (err) {
      console.error(`[Images] Failed to fetch assets:`, err);
    }
  }

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
