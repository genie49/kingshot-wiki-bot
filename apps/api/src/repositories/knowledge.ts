import type { SupabaseClient } from "@supabase/supabase-js";
import type { Category, KnowledgeAsset, KnowledgeSearchResult, KnowledgeSourceType } from "../types.js";

type CreateKnowledgeItemInput = {
  title: string;
  summary: string;
  body: string;
  categoryId?: string;
  tags?: string[];
  sourceType?: KnowledgeSourceType;
  sourceNote?: string;
  status: "draft" | "published" | "needs_review";
  metadata?: Record<string, unknown>;
};

type CreateKnowledgeAssetInput = {
  knowledgeItemId: string;
  gcsUrl: string;
  mimeType: string;
  ocrText?: string;
  visionCaption?: string;
  sortOrder: number;
};

type CreateKnowledgeChunkInput = {
  knowledgeItemId: string;
  chunkText: string;
  chunkType: "summary" | "body" | "ocr" | "image_caption";
  embedding: number[];
  metadata?: Record<string, unknown>;
};

type ListKnowledgeItemsOptions = {
  status?: string;
  limit?: number;
};

type UpdateKnowledgeItemInput = {
  title?: string;
  summary?: string;
  body?: string;
  categoryId?: string | null;
  tags?: string[];
  sourceType?: KnowledgeSourceType;
  sourceNote?: string | null;
  status?: "draft" | "published" | "needs_review";
};

function toVectorLiteral(embedding: number[]) {
  return `[${embedding.join(",")}]`;
}

export class KnowledgeRepository {
  constructor(private readonly db: SupabaseClient) {}

  async listCategories(): Promise<Category[]> {
    const { data, error } = await this.db
      .from("categories")
      .select("id, slug, name, description, parent_id")
      .order("sort_order", { ascending: true });

    if (error) throw error;
    return data ?? [];
  }

  async semanticSearch(queryEmbedding: number[], matchCount = 6): Promise<KnowledgeSearchResult[]> {
    const { data, error } = await this.db.rpc("match_knowledge_chunks", {
      query_embedding: queryEmbedding,
      match_count: matchCount
    });

    if (error) throw error;
    return data ?? [];
  }

  async getAssetsForItems(itemIds: string[]): Promise<KnowledgeAsset[]> {
    if (itemIds.length === 0) return [];

    const { data, error } = await this.db
      .from("knowledge_assets")
      .select("id, knowledge_item_id, gcs_url, mime_type, ocr_text, vision_caption, sort_order")
      .in("knowledge_item_id", itemIds)
      .order("sort_order", { ascending: true });

    if (error) throw error;
    return data ?? [];
  }

  async createKnowledgeItem(input: CreateKnowledgeItemInput) {
    const { data, error } = await this.db
      .from("knowledge_items")
      .insert({
        title: input.title,
        summary: input.summary,
        body: input.body,
        category_id: input.categoryId,
        tags: input.tags ?? [],
        source_type: input.sourceType ?? "ai",
        source_note: input.sourceNote,
        status: input.status,
        metadata: input.metadata ?? {}
      })
      .select("id, title, summary, status")
      .single();

    if (error) throw error;
    return data;
  }

  async createKnowledgeAssets(inputs: CreateKnowledgeAssetInput[]) {
    if (inputs.length === 0) return [];

    const { data, error } = await this.db
      .from("knowledge_assets")
      .insert(
        inputs.map((input) => ({
          knowledge_item_id: input.knowledgeItemId,
          gcs_url: input.gcsUrl,
          mime_type: input.mimeType,
          ocr_text: input.ocrText,
          vision_caption: input.visionCaption,
          sort_order: input.sortOrder
        }))
      )
      .select("id, knowledge_item_id, gcs_url, mime_type, ocr_text, vision_caption, sort_order");

    if (error) throw error;
    return data ?? [];
  }

  async createKnowledgeChunks(inputs: CreateKnowledgeChunkInput[]) {
    if (inputs.length === 0) return [];

    const { data, error } = await this.db
      .from("knowledge_chunks")
      .insert(
        inputs.map((input) => ({
          knowledge_item_id: input.knowledgeItemId,
          chunk_text: input.chunkText,
          chunk_type: input.chunkType,
          embedding: toVectorLiteral(input.embedding),
          metadata: input.metadata ?? {}
        }))
      )
      .select("id, knowledge_item_id, chunk_type");

    if (error) throw error;
    return data ?? [];
  }

  async listKnowledgeItems(options: ListKnowledgeItemsOptions = {}) {
    let query = this.db
      .from("knowledge_items")
      .select(`
        id,
        title,
        summary,
        body,
        tags,
        status,
        source_type,
        source_note,
        created_at,
        updated_at,
        category:categories(id, slug, name),
        assets:knowledge_assets(id, gcs_url, mime_type, sort_order)
      `)
      .order("created_at", { ascending: false })
      .limit(options.limit ?? 50);

    if (options.status) {
      query = query.eq("status", options.status);
    }

    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  async getKnowledgeItem(id: string) {
    const { data, error } = await this.db
      .from("knowledge_items")
      .select(`
        id,
        title,
        summary,
        body,
        tags,
        status,
        source_type,
        source_note,
        metadata,
        created_at,
        updated_at,
        category:categories(id, slug, name),
        assets:knowledge_assets(id, gcs_url, mime_type, ocr_text, vision_caption, sort_order)
      `)
      .eq("id", id)
      .single();

    if (error) throw error;
    return data;
  }

  async updateKnowledgeItem(id: string, input: UpdateKnowledgeItemInput) {
    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString()
    };

    if (input.title !== undefined) patch.title = input.title;
    if (input.summary !== undefined) patch.summary = input.summary;
    if (input.body !== undefined) patch.body = input.body;
    if (input.categoryId !== undefined) patch.category_id = input.categoryId;
    if (input.tags !== undefined) patch.tags = input.tags;
    if (input.sourceType !== undefined) patch.source_type = input.sourceType;
    if (input.sourceNote !== undefined) patch.source_note = input.sourceNote;
    if (input.status !== undefined) patch.status = input.status;

    const { data, error } = await this.db
      .from("knowledge_items")
      .update(patch)
      .eq("id", id)
      .select("id, title, summary, status, updated_at")
      .single();

    if (error) throw error;
    return data;
  }

  async deleteKnowledgeItem(id: string) {
    const { error: chunkError } = await this.db.from("knowledge_chunks").delete().eq("knowledge_item_id", id);
    if (chunkError) throw chunkError;

    const { error: assetError } = await this.db.from("knowledge_assets").delete().eq("knowledge_item_id", id);
    if (assetError) throw assetError;

    const { error } = await this.db.from("knowledge_items").delete().eq("id", id);
    if (error) throw error;
    return { id };
  }
}
