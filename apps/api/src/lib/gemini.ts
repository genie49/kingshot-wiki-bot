import { GoogleGenerativeAIEmbeddings, ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { config, requireConfig } from "../config.js";

export function createChatModel() {
  return new ChatGoogleGenerativeAI({
    apiKey: requireConfig("GEMINI_API_KEY"),
    model: config.GEMINI_GENERATION_MODEL,
    temperature: 0.2
  });
}

export function createEmbeddingModel() {
  return new GoogleGenerativeAIEmbeddings({
    apiKey: requireConfig("GEMINI_API_KEY"),
    model: config.GEMINI_EMBEDDING_MODEL
  });
}

export function normalizeEmbeddingDimensions(embedding: number[]) {
  const dimensions = config.GEMINI_EMBEDDING_DIMENSIONS;
  if (embedding.length === dimensions) return embedding;
  if (embedding.length > dimensions) return embedding.slice(0, dimensions);
  return [...embedding, ...Array.from({ length: dimensions - embedding.length }, () => 0)];
}
