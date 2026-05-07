import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import {
  Database,
  ImagePlus,
  MessageSquareText,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import remarkGfm from "remark-gfm";
import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

type Tab = "chat" | "knowledge" | "edit";
type KnowledgeStatus = "draft" | "published" | "needs_review";

type ChatResponse = {
  answer: string;
  sources: { id: string; title: string; summary: string; similarity: number }[];
  images: { id: string; url: string; mimeType: string; knowledgeItemId: string }[];
};

type StreamEvent =
  | { type: "metadata"; sources: ChatResponse["sources"]; images: ChatResponse["images"] }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; error: string };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: ChatResponse["sources"];
  images?: ChatResponse["images"];
  streaming?: boolean;
};

type Category = {
  id: string;
  slug: string;
  name: string;
};

type KnowledgeItem = {
  id: string;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  status: KnowledgeStatus;
  source_note: string | null;
  category: Category | null;
  assets: { id: string; gcs_url: string; mime_type: string; sort_order: number }[];
};

type ModalState =
  | { type: "image"; url: string }
  | { type: "source"; source: ChatResponse["sources"][number] }
  | { type: "item"; item: KnowledgeItem }
  | null;

const statusLabels: Record<KnowledgeStatus, string> = {
  draft: "초안",
  published: "게시됨",
  needs_review: "검수 필요"
};

function emptyDraft() {
  return {
    title: "",
    summary: "",
    body: "",
    tags: "",
    status: "draft" as KnowledgeStatus,
    categoryId: ""
  };
}

function App() {
  const [activeTab, setActiveTab] = useState<Tab>("chat");
  const [question, setQuestion] = useState("집결 편성은 어떻게 잡아야 해?");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [body, setBody] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | KnowledgeStatus>("all");
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState(emptyDraft());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<ModalState>(null);

  const selectedItem = items.find((item) => item.id === selectedId);
  const filteredItems = useMemo(() => items, [items]);

  async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data.error ?? data.message ?? `Request failed: ${response.status}`);
    }
    return data as T;
  }

  async function loadKnowledge(nextStatus = statusFilter) {
    const params = new URLSearchParams();
    if (nextStatus !== "all") params.set("status", nextStatus);
    const data = await requestJson<{ items: KnowledgeItem[] }>(
      `${apiBaseUrl}/knowledge?${params.toString()}`
    );
    setItems(data.items);
    if (selectedId && !data.items.some((item) => item.id === selectedId)) {
      setSelectedId("");
      setDraft(emptyDraft());
    }
  }

  async function loadCategories() {
    const data = await requestJson<{ categories: Category[] }>(`${apiBaseUrl}/categories`);
    setCategories(data.categories);
  }

  function selectItem(item: KnowledgeItem) {
    setSelectedId(item.id);
    setDraft({
      title: item.title,
      summary: item.summary,
      body: item.body,
      tags: item.tags.join(", "),
      status: item.status,
      categoryId: item.category?.id ?? ""
    });
  }

  function addDroppedFiles(fileList: FileList | null) {
    const dropped = Array.from(fileList ?? []).filter((file) => file.type.startsWith("image/"));
    if (dropped.length > 0) {
      setImages((current) => [...current, ...dropped]);
    }
  }

  function appendToAssistantMessage(messageId: string, update: Partial<ChatMessage>) {
    setChatMessages((current) =>
      current.map((message) =>
        message.id === messageId
          ? {
              ...message,
              ...update,
              content:
                typeof update.content === "string"
                  ? update.content
                  : message.content + (update.streaming ? "" : "")
            }
          : message
      )
    );
  }

  function updateAssistantContent(messageId: string, delta: string) {
    setChatMessages((current) =>
      current.map((message) =>
        message.id === messageId ? { ...message, content: message.content + delta } : message
      )
    );
  }

  function parseSseEvents(buffer: string) {
    const parts = buffer.split("\n\n");
    const rest = parts.pop() ?? "";
    const events = parts
      .map((part) => {
        const dataLine = part
          .split("\n")
          .find((line) => line.startsWith("data: "));
        if (!dataLine) return null;
        return JSON.parse(dataLine.slice(6)) as StreamEvent;
      })
      .filter((event): event is StreamEvent => Boolean(event));
    return { events, rest };
  }

  async function submitQuestion() {
    const trimmedQuestion = question.trim();
    if (!trimmedQuestion) return;

    setBusy(true);
    setError("");
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmedQuestion
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      sources: [],
      images: [],
      streaming: true
    };
    setChatMessages((current) => [...current, userMessage, assistantMessage]);
    setQuestion("");

    try {
      const response = await fetch(`${apiBaseUrl}/query/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmedQuestion })
      });
      if (!response.ok || !response.body) {
        const text = await response.text();
        throw new Error(text || `Request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.rest;

        for (const event of parsed.events) {
          if (event.type === "metadata") {
            appendToAssistantMessage(assistantMessage.id, {
              sources: event.sources,
              images: event.images
            });
          }
          if (event.type === "text") {
            updateAssistantContent(assistantMessage.id, event.delta);
          }
          if (event.type === "error") {
            throw new Error(event.error);
          }
        }
      }

      appendToAssistantMessage(assistantMessage.id, { streaming: false });
    } catch (event) {
      setError(event instanceof Error ? event.message : "질의 중 오류가 발생했습니다.");
      appendToAssistantMessage(assistantMessage.id, { streaming: false });
    } finally {
      setBusy(false);
    }
  }

  async function submitIngest() {
    setBusy(true);
    setError("");
    try {
      const form = new FormData();
      form.set("body", body);
      for (const image of images) form.append("images", image);
      await requestJson(`${apiBaseUrl}/ingest`, { method: "POST", body: form });
      setBody("");
      setImages([]);
      await loadKnowledge();
      setActiveTab("knowledge");
    } catch (event) {
      setError(event instanceof Error ? event.message : "지식 추가 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSelected() {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`${apiBaseUrl}/knowledge/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draft.title,
          summary: draft.summary,
          body: draft.body,
          tags: draft.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          status: draft.status,
          categoryId: draft.categoryId || null
        })
      });
      await loadKnowledge();
    } catch (event) {
      setError(event instanceof Error ? event.message : "저장 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selectedId) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`${apiBaseUrl}/knowledge/${selectedId}`, { method: "DELETE" });
      setSelectedId("");
      setDraft(emptyDraft());
      await loadKnowledge();
    } catch (event) {
      setError(event instanceof Error ? event.message : "삭제 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void loadCategories().catch((event) =>
      setError(event instanceof Error ? event.message : "카테고리를 불러오지 못했습니다.")
    );
    void loadKnowledge().catch((event) =>
      setError(event instanceof Error ? event.message : "지식을 불러오지 못했습니다.")
    );
  }, []);

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Kingshot Knowledge Ops</p>
          <h1>킹샷 위키 봇</h1>
        </div>
        <div className="status-pill">
          <Database size={16} />
          Hono RAG
        </div>
      </section>

      <nav className="tabs">
        <button className={activeTab === "chat" ? "active" : ""} onClick={() => setActiveTab("chat")}>
          <MessageSquareText size={16} />
          채팅
        </button>
        <button
          className={activeTab === "knowledge" ? "active" : ""}
          onClick={() => setActiveTab("knowledge")}
        >
          <Search size={16} />
          지식 조회
        </button>
        <button className={activeTab === "edit" ? "active" : ""} onClick={() => setActiveTab("edit")}>
          <Pencil size={16} />
          지식 수정
        </button>
      </nav>

      {error && (
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={() => setError("")}>
            <X size={16} />
          </button>
        </div>
      )}

      {activeTab === "chat" && (
        <section className="page-panel chat-page">
          <div className="chat-thread">
            {chatMessages.length === 0 && (
              <div className="chat-empty">
                <Sparkles size={22} />
                <strong>킹샷 운영 질문을 시작하세요.</strong>
                <span>답변은 실시간으로 흘러오고, 관련 이미지와 인용은 답변 아래에 붙습니다.</span>
              </div>
            )}
            {chatMessages.map((message) => (
              <article key={message.id} className={`chat-message ${message.role}`}>
                <div className="message-bubble">
                  <div className="message-label">{message.role === "user" ? "나" : "킹샷 위키 봇"}</div>
                  <div className="message-content">
                    {message.role === "assistant" && message.content ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                    ) : (
                      message.content || (message.streaming ? "답변을 준비하는 중..." : "")
                    )}
                    {message.streaming && <span className="stream-cursor" />}
                  </div>
                  {message.images && message.images.length > 0 && (
                    <div className="query-images">
                      {message.images.map((image) => (
                        <button key={image.id} onClick={() => setModal({ type: "image", url: image.url })}>
                          <img src={image.url} alt="" />
                        </button>
                      ))}
                    </div>
                  )}
                  {message.sources && message.sources.length > 0 && (
                    <div className="citation-chips">
                      {message.sources.map((source, index) => (
                        <button key={source.id} onClick={() => setModal({ type: "source", source })}>
                          <span className="citation-title">
                            {index + 1}. {source.title}
                          </span>
                          <span className="citation-score">{Math.round(source.similarity * 100)}%</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          <div className="chat-composer">
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submitQuestion();
                }
              }}
              placeholder="킹샷에 대해 질문"
            />
            <button onClick={submitQuestion} disabled={busy || question.trim().length === 0}>
              <Send size={16} />
              질문하기
            </button>
          </div>
        </section>
      )}

      {activeTab === "knowledge" && (
        <section className="page-panel">
          <div className="review-header">
            <div>
              <p className="eyebrow">Knowledge Browser</p>
              <h2>지식 조회</h2>
            </div>
            <FilterBar
              busy={busy}
              statusFilter={statusFilter}
              onRefresh={() => loadKnowledge()}
              onStatusChange={(nextStatus) => {
                setStatusFilter(nextStatus);
                void loadKnowledge(nextStatus);
              }}
            />
          </div>
          <div className="knowledge-cards">
            {filteredItems.map((item) => (
              <button key={item.id} className="knowledge-card" onClick={() => setModal({ type: "item", item })}>
                <span className={`status-dot ${item.status}`} />
                <strong>{item.title}</strong>
                <small>{item.category?.name ?? "미분류"} · {statusLabels[item.status]}</small>
                <p>{item.summary}</p>
              </button>
            ))}
          </div>
        </section>
      )}

      {activeTab === "edit" && (
        <section className="page-panel">
          <div className="review-header">
            <div>
              <p className="eyebrow">Knowledge Editor</p>
              <h2>지식 수정</h2>
            </div>
            <FilterBar
              busy={busy}
              statusFilter={statusFilter}
              onRefresh={() => loadKnowledge()}
              onStatusChange={(nextStatus) => {
                setStatusFilter(nextStatus);
                void loadKnowledge(nextStatus);
              }}
            />
          </div>

          <div className="edit-layout">
            <div className="ingest-box">
              <div className="panel-title">
                <ImagePlus size={18} />
                지식 추가
              </div>
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                placeholder="이미지에 대한 설명, 보상표 해석, 이벤트 운영 팁 등을 입력"
              />
              <label
                className={`file-drop ${isDragging ? "dragging" : ""}`}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setIsDragging(false);
                  addDroppedFiles(event.dataTransfer.files);
                }}
              >
                <ImagePlus size={18} />
                <span>{images.length > 0 ? `${images.length}개 이미지 선택됨` : "이미지를 드래그하거나 선택"}</span>
                <input
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => addDroppedFiles(event.target.files)}
                />
              </label>
              <button onClick={submitIngest} disabled={busy || body.trim().length === 0}>
                <Sparkles size={16} />
                메타데이터 생성
              </button>
            </div>

            <div className="editor-shell">
              <div className="item-list">
                {items.map((item) => (
                  <button
                    key={item.id}
                    className={`item-row ${item.id === selectedId ? "active" : ""}`}
                    onClick={() => selectItem(item)}
                  >
                    <span className={`status-dot ${item.status}`} />
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.category?.name ?? "미분류"} · {statusLabels[item.status]}</small>
                    </span>
                  </button>
                ))}
              </div>

              <div className="editor">
                {selectedItem ? (
                  <>
                    <div className="editor-fields">
                      <input
                        value={draft.title}
                        onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                        placeholder="제목"
                      />
                      <textarea
                        className="compact"
                        value={draft.summary}
                        onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
                        placeholder="요약"
                      />
                      <textarea
                        value={draft.body}
                        onChange={(event) => setDraft({ ...draft, body: event.target.value })}
                        placeholder="본문"
                      />
                      <input
                        value={draft.tags}
                        onChange={(event) => setDraft({ ...draft, tags: event.target.value })}
                        placeholder="태그, 쉼표로 구분"
                      />
                      <div className="field-row">
                        <select
                          value={draft.categoryId}
                          onChange={(event) => setDraft({ ...draft, categoryId: event.target.value })}
                        >
                          <option value="">미분류</option>
                          {categories.map((category) => (
                            <option key={category.id} value={category.id}>
                              {category.name}
                            </option>
                          ))}
                        </select>
                        <select
                          value={draft.status}
                          onChange={(event) =>
                            setDraft({ ...draft, status: event.target.value as KnowledgeStatus })
                          }
                        >
                          <option value="needs_review">검수 필요</option>
                          <option value="published">게시됨</option>
                          <option value="draft">초안</option>
                        </select>
                      </div>
                    </div>

                    <div className="asset-strip">
                      {selectedItem.assets.map((asset) => (
                        <button
                          key={asset.id}
                          onClick={() => setModal({ type: "image", url: asset.gcs_url })}
                        >
                          <img src={asset.gcs_url} alt="" />
                        </button>
                      ))}
                    </div>

                    <div className="actions">
                      <button onClick={saveSelected} disabled={busy}>
                        <Save size={16} />
                        저장
                      </button>
                      <button className="danger" onClick={deleteSelected} disabled={busy}>
                        <Trash2 size={16} />
                        삭제
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-state">수정할 지식 항목을 선택하세요.</div>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {modal && <Modal modal={modal} onClose={() => setModal(null)} />}
    </main>
  );
}

function FilterBar({
  busy,
  statusFilter,
  onRefresh,
  onStatusChange
}: {
  busy: boolean;
  statusFilter: "all" | KnowledgeStatus;
  onRefresh: () => void;
  onStatusChange: (status: "all" | KnowledgeStatus) => void;
}) {
  return (
    <div className="toolbar">
      <select value={statusFilter} onChange={(event) => onStatusChange(event.target.value as "all" | KnowledgeStatus)}>
        <option value="all">전체</option>
        <option value="needs_review">검수 필요</option>
        <option value="published">게시됨</option>
        <option value="draft">초안</option>
      </select>
      <button className="icon-button" onClick={onRefresh} disabled={busy}>
        <RefreshCw size={16} />
      </button>
    </div>
  );
}

function Modal({ modal, onClose }: { modal: ModalState; onClose: () => void }) {
  if (!modal) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <X size={18} />
        </button>
        {modal.type === "image" && <img className="modal-image" src={modal.url} alt="" />}
        {modal.type === "source" && (
          <div className="modal-text">
            <p className="eyebrow">Citation</p>
            <h2>{modal.source.title}</h2>
            <small className="similarity">유사도 {Math.round(modal.source.similarity * 100)}%</small>
            <p>{modal.source.summary}</p>
          </div>
        )}
        {modal.type === "item" && (
          <div className="modal-text">
            <p className="eyebrow">{modal.item.category?.name ?? "미분류"}</p>
            <h2>{modal.item.title}</h2>
            <p>{modal.item.summary}</p>
            <div className="tag-line">{modal.item.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
            {modal.item.assets.length > 0 && (
              <div className="asset-strip">
                {modal.item.assets.map((asset) => (
                  <img key={asset.id} src={asset.gcs_url} alt="" />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
