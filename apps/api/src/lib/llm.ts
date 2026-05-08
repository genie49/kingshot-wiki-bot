import { ChatGoogleGenerativeAI, GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { ChatXAI } from "@langchain/xai";
import { config, requireConfig } from "../config.js";

const XAI_EMPTY_CONTENT_PLACEHOLDER = " ";

function isEmptyContent(content: unknown) {
  if (content == null) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) {
    if (content.length === 0) return true;
    return content.every((part) => {
      if (part == null) return true;
      if (typeof part === "string") return part.length === 0;
      if (typeof part === "object" && part !== null && "text" in part) {
        return typeof (part as { text?: unknown }).text === "string"
          && ((part as { text: string }).text.length === 0);
      }
      return false;
    });
  }
  return false;
}

function patchXAIClient(model: ChatXAI) {
  const original = (model as any).completionWithRetry.bind(model);
  (model as any).completionWithRetry = (request: any, options?: any) => {
    let patched = request;
    if (Array.isArray(request?.messages)) {
      patched = {
        ...request,
        messages: request.messages.map((msg: any) => {
          if (msg && isEmptyContent(msg.content)) {
            return { ...msg, content: XAI_EMPTY_CONTENT_PLACEHOLDER };
          }
          return msg;
        })
      };
    }
    return original(patched, options);
  };
  return model;
}

export function createChatModel() {
  return new ChatGoogleGenerativeAI({
    apiKey: requireConfig("GEMINI_API_KEY"),
    model: config.GEMINI_GENERATION_MODEL,
    temperature: 0.2
  });
}

export function createMainAgentChatModel() {
  return patchXAIClient(
    new ChatXAI({
      apiKey: requireConfig("XAI_API_KEY"),
      model: config.XAI_GENERATION_MODEL,
      temperature: 0.2
    })
  );
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
