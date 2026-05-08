export type KnowledgeStatus = "draft" | "published" | "needs_review";

export type KnowledgeSourceType = "ai" | "swalove";

export type Category = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  parent_id: string | null;
};

export type KnowledgeAsset = {
  id: string;
  knowledge_item_id: string;
  gcs_url: string;
  mime_type: string;
  ocr_text: string | null;
  vision_caption: string | null;
  sort_order: number;
};

export type KnowledgeSearchResult = {
  chunk_id: string;
  knowledge_item_id: string;
  title: string;
  summary: string;
  chunk_text: string;
  similarity: number;
};
