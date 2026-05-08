import { z } from "zod";
import { createChatModel, createEmbeddingModel, normalizeEmbeddingDimensions } from "../lib/llm.js";
import { createSupabaseServiceClient } from "../lib/supabase.js";
import { KnowledgeRepository } from "../repositories/knowledge.js";
import type { Category } from "../types.js";

export const ingestRequestSchema = z.object({
  body: z.string().min(1),
  sourceType: z.enum(["ai", "swalove"]).default("ai"),
  assets: z
    .array(
      z.object({
        url: z.string().url(),
        mimeType: z.string().default("image/*")
      })
    )
    .default([]),
  imageUrls: z.array(z.string().url()).default([]),
  sourceNote: z.string().optional()
});

export type IngestRequest = z.infer<typeof ingestRequestSchema>;

const enrichmentSchema = z.object({
  categorySlug: z.string().describe("Best matching category slug from the provided taxonomy."),
  title: z.string().min(1).max(120).describe("Concise Korean title for this knowledge item."),
  summary: z
    .string()
    .min(1)
    .max(320)
    .describe("Two Korean sentences explaining what this note is about."),
  tags: z.array(z.string()).min(1).max(8).describe("Short Korean or slug-like searchable tags."),
  confidence: z.number().min(0).max(1).describe("Confidence for category selection and metadata quality.")
});

type Enrichment = z.infer<typeof enrichmentSchema>;

function heuristicEnrichment(body: string, categories: Category[]): Enrichment {
  const category = categories.find((candidate) =>
    body.toLowerCase().includes(candidate.name.toLowerCase())
  ) ?? categories.find((candidate) => candidate.slug === "faq-tips") ?? categories[0];

  return {
    categorySlug: category?.slug ?? "faq-tips",
    title: body.split("\n")[0]?.slice(0, 80) || "킹샷 정보",
    summary: body.slice(0, 220),
    tags: category ? [category.slug] : ["faq-tips"],
    confidence: 0.35
  };
}

async function enrichKnowledge(body: string, categories: Category[], assetCount: number): Promise<Enrichment> {
  const taxonomy = categories
    .map((category) => `- ${category.slug}: ${category.name} (${category.description ?? ""})`)
    .join("\n");
  const fallback = heuristicEnrichment(body, categories);

  try {
    const model = createChatModel().withStructuredOutput(enrichmentSchema, {
      name: "KingshotKnowledgeEnrichment"
    });
    const result = await model.invoke([
      {
        role: "system",
        content:
          "You enrich uploaded Kingshot(킹샷) wiki knowledge. " +
          "Use only the provided taxonomy slugs. Write title, summary, and tags in Korean unless a game term is normally English. " +
          "The summary must be exactly two concise sentences. Do not invent facts."
      },
      {
        role: "user",
        content:
          `Taxonomy:\n${taxonomy}\n\n` +
          `Uploaded image count: ${assetCount}\n\n` +
          `Human explanation:\n${body}`
      }
    ]);
    const parsed = enrichmentSchema.parse(result);
    const categoryExists = categories.some((category) => category.slug === parsed.categorySlug);
    return categoryExists ? parsed : { ...parsed, categorySlug: fallback.categorySlug, confidence: 0.2 };
  } catch (error) {
    console.warn("Gemini enrichment failed; using heuristic fallback.", error);
    return fallback;
  }
}

export async function ingestKnowledge(input: IngestRequest) {
  const db = createSupabaseServiceClient();
  const repository = new KnowledgeRepository(db);
  const embeddings = createEmbeddingModel();
  const categories = await repository.listCategories();
  const mergedAssets = [
    ...input.assets,
    ...input.imageUrls.map((url) => ({
      url,
      mimeType: "image/*"
    }))
  ];
  const enrichment = await enrichKnowledge(input.body, categories, mergedAssets.length);

  const selectedCategory = categories.find((category) => category.slug === enrichment.categorySlug)
    ?? categories.find((category) => category.slug === "faq-tips")
    ?? categories[0];
  const title = enrichment.title;
  const summary = enrichment.summary;
  const embeddingText = [title, summary, input.body].join("\n\n");
  const embedding = normalizeEmbeddingDimensions(await embeddings.embedQuery(embeddingText));
  const item = await repository.createKnowledgeItem({
    title,
    summary,
    body: input.body,
    categoryId: selectedCategory?.id,
    tags: enrichment.tags,
    sourceType: input.sourceType,
    sourceNote: input.sourceNote,
    status: enrichment.confidence < 0.45 ? "needs_review" : "published",
    metadata: {
      enrichment: "openrouter_structured",
      enrichmentConfidence: enrichment.confidence,
      embeddingDimensions: embedding.length,
      selectedCategorySlug: enrichment.categorySlug
    }
  });

  const assets = await repository.createKnowledgeAssets(
    mergedAssets.map((asset, index) => ({
      knowledgeItemId: item.id,
      gcsUrl: asset.url,
      mimeType: asset.mimeType,
      sortOrder: index
    }))
  );

  const chunks = await repository.createKnowledgeChunks([
    {
      knowledgeItemId: item.id,
      chunkText: [title, summary, input.body].join("\n\n"),
      chunkType: "body",
      embedding,
      metadata: { source: "knowledge_item" }
    }
  ]);

  return {
    status: item.status,
    id: item.id,
    selectedCategory,
    title,
    summary,
    tags: enrichment.tags,
    enrichmentConfidence: enrichment.confidence,
    assets,
    chunks,
    embeddingDimensions: embedding.length,
    note: "Stored through the Hono API with OpenRouter structured metadata enrichment."
  };
}
