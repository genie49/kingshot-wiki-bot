import {
  ChangeEvent,
  DragEvent,
  KeyboardEvent,
  StrictMode,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  ListChecks,
  Lock,
  Menu,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  X
} from "lucide-react";
import "./styles.css";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";
const editPassword = import.meta.env.VITE_EDIT_PASSWORD ?? "kingshot";

const UNLOCK_KEY = "kingshot.unlock.at";
const UNLOCK_DURATION_MS = 24 * 60 * 60 * 1000;

type Tab = "chat" | "browse" | "edit";

const TAB_TO_PATH: Record<Tab, string> = {
  chat: "/chat",
  browse: "/browse",
  edit: "/edit"
};

const PATH_TO_TAB: Record<string, Tab> = {
  "/": "chat",
  "/chat": "chat",
  "/browse": "browse",
  "/edit": "edit"
};

function tabFromLocation(): Tab {
  if (typeof window === "undefined") return "chat";
  return PATH_TO_TAB[window.location.pathname] ?? "chat";
}

function readUnlockState(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = window.localStorage.getItem(UNLOCK_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    return Date.now() - ts < UNLOCK_DURATION_MS;
  } catch {
    return false;
  }
}

type Source = { id: string; title: string; summary: string; similarity: number };

type ImageRef = { id: string; url: string; mimeType: string; knowledgeItemId: string };

type ChatResponse = {
  answer: string;
  sources: Source[];
  images: ImageRef[];
};

type StreamEvent =
  | { type: "metadata"; sources: Source[]; images: ImageRef[] }
  | { type: "text"; delta: string }
  | { type: "done" }
  | { type: "error"; error: string };

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: Source[];
  images?: ImageRef[];
  streaming?: boolean;
  errored?: boolean;
};

type Category = { id: string; slug: string; name: string };

type KnowledgeSourceType = "ai" | "swalove";

type KnowledgeItem = {
  id: string;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  status: string;
  source_type: KnowledgeSourceType;
  source_note: string | null;
  created_at: string;
  updated_at: string;
  category: Category | null;
  assets: { id: string; gcs_url: string; mime_type: string; sort_order: number }[];
};

type ConversationSummary = {
  id: string;
  title: string;
  messages: ChatMessage[];
};

type ImageModalState = { url: string; name?: string };

const SUGGESTIONS = [
  { t: "집결 편성은 어떻게 잡아야 해?", c: "집결·전투" },
  { t: "왕좌의 시간 보상 구간", c: "이벤트" },
  { t: "본부 26 자원 견적", c: "건설·자원" },
  { t: "서버 합방 D-7 체크리스트", c: "동맹 운영" }
];

const PLACEHOLDER = "킹샷에 대한 질문을 물어보세요";

const SOURCE_LABELS: Record<KnowledgeSourceType, string> = {
  ai: "AI",
  swalove: "스왈로브"
};

function getSourceLabel(value: string | null | undefined) {
  return SOURCE_LABELS[value as KnowledgeSourceType] ?? "AI";
}

function sortNewestFirst(items: KnowledgeItem[]) {
  return [...items].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  );
}

function uid() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// CommonMark refuses to close ** when the closing run sits between punctuation
// and a non-space, non-punctuation char (e.g. **'해적의 보물'**입니다). LLM output
// hits this routinely with Korean text. This plugin walks the parsed mdast and
// converts any leftover **...** pairs inside text nodes into proper strong nodes.
function remarkRecoverBold() {
  const splitText = (value: string) => {
    const regex = /\*\*([^*\n]+?)\*\*/g;
    const segments: Array<{ type: string; value?: string; children?: unknown[] }> = [];
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
      if (match.index > last) {
        segments.push({ type: "text", value: value.slice(last, match.index) });
      }
      segments.push({
        type: "strong",
        children: [{ type: "text", value: match[1] }]
      });
      last = match.index + match[0].length;
    }
    if (segments.length === 0) return null;
    if (last < value.length) {
      segments.push({ type: "text", value: value.slice(last) });
    }
    return segments;
  };

  const walk = (nodes: unknown[]): unknown[] => {
    const out: unknown[] = [];
    for (const raw of nodes) {
      const node = raw as { type?: string; value?: string; children?: unknown[] };
      if (!node || typeof node !== "object") {
        out.push(raw);
        continue;
      }
      if (node.type === "code" || node.type === "inlineCode") {
        out.push(raw);
        continue;
      }
      if (
        node.type === "text" &&
        typeof node.value === "string" &&
        node.value.includes("**")
      ) {
        const split = splitText(node.value);
        if (split) {
          out.push(...split);
          continue;
        }
      }
      if (Array.isArray(node.children)) {
        node.children = walk(node.children);
      }
      out.push(raw);
    }
    return out;
  };

  return (tree: { children?: unknown[] }) => {
    if (Array.isArray(tree.children)) {
      tree.children = walk(tree.children);
    }
  };
}

const MD_PLUGINS = [remarkGfm, remarkRecoverBold];

function App() {
  const [tab, setTab] = useState<Tab>(() => tabFromLocation());

  // Chat state
  const [composerValue, setComposerValue] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [retryQuestion, setRetryQuestion] = useState<string | null>(null);

  // Knowledge state
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [browseQuery, setBrowseQuery] = useState("");
  const [browseCategoryId, setBrowseCategoryId] = useState<string>("");
  const [modalIndex, setModalIndex] = useState<number | null>(null);

  // Edit state
  const [unlocked, setUnlocked] = useState<boolean>(() => readUnlockState());
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordWrong, setPasswordWrong] = useState(false);
  const [editView, setEditView] = useState<"editor" | "ingest">("editor");
  const [selectedId, setSelectedId] = useState<string>("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftSummary, setDraftSummary] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [draftTags, setDraftTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [draftCategoryId, setDraftCategoryId] = useState<string>("");
  const [editListQuery, setEditListQuery] = useState("");
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");

  // Ingest state
  const [ingestBody, setIngestBody] = useState("");
  const [ingestSourceType, setIngestSourceType] = useState<KnowledgeSourceType>("ai");
  const [ingestImages, setIngestImages] = useState<File[]>([]);
  const [ingestDragging, setIngestDragging] = useState(false);
  const [ingestBusy, setIngestBusy] = useState(false);
  const [ingestSavedId, setIngestSavedId] = useState<string | null>(null);
  const [ingestError, setIngestError] = useState<string | null>(null);

  // Image lightbox
  const [imageModal, setImageModal] = useState<ImageModalState | null>(null);

  // Citation modal
  const [citationModal, setCitationModal] = useState<{ source: Source; index: number } | null>(
    null
  );

  // Mobile drawer
  const [drawerOpen, setDrawerOpen] = useState(false);

  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const ingestPreviewUrls = useRef<string[]>([]);

  const selectedItem = useMemo(
    () => items.find((it) => it.id === selectedId) ?? null,
    [items, selectedId]
  );

  const filteredItems = useMemo(() => {
    const q = browseQuery.trim().toLowerCase();
    return sortNewestFirst(items.filter((it) => {
      if (browseCategoryId && it.category?.id !== browseCategoryId) return false;
      if (!q) return true;
      return (
        it.title.toLowerCase().includes(q) ||
        it.summary.toLowerCase().includes(q) ||
        it.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    }));
  }, [items, browseQuery, browseCategoryId]);

  const editFilteredItems = useMemo(() => {
    const q = editListQuery.trim().toLowerCase();
    const filtered = q ? items.filter((it) => it.title.toLowerCase().includes(q)) : items;
    return sortNewestFirst(filtered);
  }, [items, editListQuery]);

  const ingestPreviews = useMemo(() => {
    ingestPreviewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    ingestPreviewUrls.current = ingestImages.map((file) => URL.createObjectURL(file));
    return ingestPreviewUrls.current;
  }, [ingestImages]);

  useEffect(() => {
    return () => {
      ingestPreviewUrls.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  // Initial load
  useEffect(() => {
    void loadCategories();
    void loadKnowledge();
  }, []);

  // Sync tab → URL
  useEffect(() => {
    const path = TAB_TO_PATH[tab];
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
  }, [tab]);

  // Sync URL → tab on back/forward
  useEffect(() => {
    function onPopState() {
      setTab(tabFromLocation());
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  // Close mobile drawer on tab change.
  useEffect(() => {
    setDrawerOpen(false);
  }, [tab]);

  // Re-check unlock window when the tab is brought back into focus.
  useEffect(() => {
    function onFocus() {
      if (unlocked && !readUnlockState()) setUnlocked(false);
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [unlocked]);

  // Auto-save conversation to sidebar once an answer completes.
  useEffect(() => {
    if (messages.length === 0) return;
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser) return;
    const hasCompleted = messages.some(
      (m) => m.role === "assistant" && !m.streaming && m.content.length > 0
    );
    if (!hasCompleted) return;
    const id = activeConversationId ?? firstUser.id;
    const title = firstUser.content.slice(0, 60);
    const summary: ConversationSummary = { id, title, messages };
    setConversations((current) => {
      const filtered = current.filter((c) => c.id !== id);
      return [summary, ...filtered].slice(0, 12);
    });
    if (!activeConversationId) setActiveConversationId(id);
  }, [messages, activeConversationId]);

  async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init);
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data.error ?? data.message ?? `Request failed: ${response.status}`);
    }
    return data as T;
  }

  async function loadCategories() {
    try {
      const data = await requestJson<{ categories: Category[] }>(`${apiBaseUrl}/categories`);
      setCategories(data.categories);
    } catch (event) {
      // Silent — sidebar continues to work without categories.
      console.warn("loadCategories", event);
    }
  }

  async function loadKnowledge() {
    try {
      const data = await requestJson<{ items: KnowledgeItem[] }>(`${apiBaseUrl}/knowledge`);
      setItems(sortNewestFirst(data.items));
    } catch (event) {
      console.warn("loadKnowledge", event);
    }
  }

  // ── Chat ───────────────────────────────────────────────────────────────
  function startNewChat() {
    setMessages([]);
    setActiveConversationId(null);
    setChatError(null);
    setRetryQuestion(null);
    setComposerValue("");
    setTab("chat");
    setDrawerOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  }

  function openConversation(id: string) {
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    setMessages(conv.messages);
    setActiveConversationId(id);
    setChatError(null);
    setRetryQuestion(null);
    setTab("chat");
    setDrawerOpen(false);
  }

  function appendToAssistant(messageId: string, update: Partial<ChatMessage>) {
    setMessages((current) =>
      current.map((m) => (m.id === messageId ? { ...m, ...update } : m))
    );
  }

  function appendDelta(messageId: string, delta: string) {
    setMessages((current) =>
      current.map((m) => (m.id === messageId ? { ...m, content: m.content + delta } : m))
    );
  }

  function parseSseEvents(buffer: string) {
    const parts = buffer.split("\n\n");
    const rest = parts.pop() ?? "";
    const events = parts
      .map((part) => {
        const dataLine = part.split("\n").find((line) => line.startsWith("data: "));
        if (!dataLine) return null;
        return JSON.parse(dataLine.slice(6)) as StreamEvent;
      })
      .filter((e): e is StreamEvent => Boolean(e));
    return { events, rest };
  }

  async function submitQuestion(textInput?: string) {
    const text = (textInput ?? composerValue).trim();
    if (!text || chatBusy) return;
    setChatBusy(true);
    setChatError(null);
    setRetryQuestion(text);
    const userMessage: ChatMessage = { id: uid(), role: "user", content: text };
    const assistantMessage: ChatMessage = {
      id: uid(),
      role: "assistant",
      content: "",
      sources: [],
      images: [],
      streaming: true
    };
    const nextMessages = [...messages, userMessage, assistantMessage];
    const queryHistory = nextMessages
      .filter((m) => m.role === "user" || (m.role === "assistant" && m.content.length > 0))
      .map((m) => ({ role: m.role, content: m.content }));
    setMessages(nextMessages);
    setComposerValue("");

    try {
      const response = await fetch(`${apiBaseUrl}/query/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text, messages: queryHistory })
      });
      if (!response.ok || !response.body) {
        const errorText = await response.text();
        throw new Error(errorText || `Request failed: ${response.status}`);
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
            appendToAssistant(assistantMessage.id, {
              sources: event.sources,
              images: event.images
            });
          }
          if (event.type === "text") appendDelta(assistantMessage.id, event.delta);
          if (event.type === "error") throw new Error(event.error);
        }
      }
      appendToAssistant(assistantMessage.id, { streaming: false });
      setRetryQuestion(null);
    } catch (event) {
      const message = event instanceof Error ? event.message : "응답을 가져오지 못했습니다.";
      setChatError(message);
      appendToAssistant(assistantMessage.id, { streaming: false, errored: true });
    } finally {
      setChatBusy(false);
    }
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitQuestion();
    }
  }

  function retryLast() {
    if (retryQuestion) {
      setMessages((current) => current.filter((m) => !(m.role === "assistant" && m.errored)));
      void submitQuestion(retryQuestion);
    }
  }

  // ── Browse ─────────────────────────────────────────────────────────────
  function openBrowseModal(index: number) {
    setModalIndex(index);
  }

  function closeBrowseModal() {
    setModalIndex(null);
  }

  function navModal(delta: number) {
    if (modalIndex === null) return;
    const next = modalIndex + delta;
    if (next < 0 || next >= filteredItems.length) return;
    setModalIndex(next);
  }

  // Keyboard nav for modal
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (modalIndex === null) return;
      if (event.key === "Escape") closeBrowseModal();
      if (event.key === "ArrowLeft") navModal(-1);
      if (event.key === "ArrowRight") navModal(1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalIndex, filteredItems.length]);

  function editFromModal() {
    if (modalIndex === null) return;
    const item = filteredItems[modalIndex];
    closeBrowseModal();
    setTab("edit");
    if (unlocked) selectItem(item);
    else setSelectedId(item.id); // remember after unlock
  }

  // ── Edit ───────────────────────────────────────────────────────────────
  function tryUnlock(value?: string) {
    const candidate = (value ?? passwordInput).trim();
    if (candidate === editPassword) {
      setUnlocked(true);
      setPasswordWrong(false);
      setPasswordInput("");
      try {
        window.localStorage.setItem(UNLOCK_KEY, String(Date.now()));
      } catch {
        // ignore — storage may be disabled
      }
      // If selectedId was set before unlock (e.g. from modal "편집"), select it now.
      if (selectedId) {
        const item = items.find((it) => it.id === selectedId);
        if (item) selectItem(item);
      }
    } else {
      setPasswordWrong(true);
    }
  }

  function selectItem(item: KnowledgeItem) {
    setSelectedId(item.id);
    setDraftTitle(item.title);
    setDraftSummary(item.summary);
    setDraftBody(item.body);
    setDraftTags([...item.tags]);
    setTagDraft("");
    setDraftCategoryId(item.category?.id ?? "");
    setEditView("editor");
  }

  function clearSelection() {
    setSelectedId("");
    setDraftTitle("");
    setDraftSummary("");
    setDraftBody("");
    setDraftTags([]);
    setTagDraft("");
    setDraftCategoryId("");
  }

  async function saveSelected() {
    if (!selectedId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await requestJson(`${apiBaseUrl}/knowledge/${selectedId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: draftTitle,
          summary: draftSummary,
          body: draftBody,
          tags: draftTags,
          categoryId: draftCategoryId || null
        })
      });
      await loadKnowledge();
    } catch (event) {
      setEditError(event instanceof Error ? event.message : "저장 중 오류가 발생했습니다.");
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selectedId) return;
    setEditBusy(true);
    setEditError(null);
    try {
      await requestJson(`${apiBaseUrl}/knowledge/${selectedId}`, { method: "DELETE" });
      clearSelection();
      setConfirmDelete(false);
      setDeleteConfirmText("");
      await loadKnowledge();
    } catch (event) {
      setEditError(event instanceof Error ? event.message : "삭제 중 오류가 발생했습니다.");
    } finally {
      setEditBusy(false);
    }
  }

  function addTag() {
    const v = tagDraft.trim().replace(/^#/, "");
    if (!v) return;
    if (draftTags.includes(v)) {
      setTagDraft("");
      return;
    }
    setDraftTags([...draftTags, v]);
    setTagDraft("");
  }

  function removeTag(t: string) {
    setDraftTags(draftTags.filter((x) => x !== t));
  }

  // ── Ingest ─────────────────────────────────────────────────────────────
  function addIngestFiles(files: FileList | null) {
    const dropped = Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
    if (dropped.length > 0) {
      setIngestImages((current) => [...current, ...dropped]);
    }
  }

  function removeIngestFile(index: number) {
    setIngestImages((current) => current.filter((_, i) => i !== index));
  }

  async function submitIngest() {
    if (ingestBusy) return;
    if (ingestBody.trim().length === 0 && ingestImages.length === 0) return;
    setIngestBusy(true);
    setIngestError(null);
    setIngestSavedId(null);
    try {
      const form = new FormData();
      form.set("body", ingestBody);
      form.set("sourceType", ingestSourceType);
      for (const image of ingestImages) form.append("images", image);
      const data = await requestJson<{ id?: string }>(`${apiBaseUrl}/ingest`, {
        method: "POST",
        body: form
      });
      setIngestBody("");
      setIngestImages([]);
      setIngestSavedId(data.id ?? "");
      await loadKnowledge();
    } catch (event) {
      setIngestError(
        event instanceof Error ? event.message : "지식 추가 중 오류가 발생했습니다."
      );
    } finally {
      setIngestBusy(false);
    }
  }

  // ── Render helpers ─────────────────────────────────────────────────────
  const sidebar = (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="sidebar-logo">K</div>
        <div className="sidebar-name">Kingshot WIKI</div>
      </div>
      <div className="sidebar-new">
        <button className="btn btn-primary btn-sm btn-full" onClick={startNewChat}>
          <Plus size={14} />새 채팅
        </button>
      </div>
      <div className="sidebar-section-label">WORKSPACE</div>
      <button
        type="button"
        className={`sidebar-item ${tab === "chat" ? "active" : ""}`}
        onClick={() => setTab("chat")}
      >
        <span className="icon">
          <MessageSquareText size={14} />
        </span>
        <span className="label">채팅</span>
      </button>
      <button
        type="button"
        className={`sidebar-item ${tab === "browse" ? "active" : ""}`}
        onClick={() => setTab("browse")}
      >
        <span className="icon">
          <Search size={14} />
        </span>
        <span className="label">지식 조회</span>
        <span className="badge">{items.length || ""}</span>
      </button>
      <button
        type="button"
        className={`sidebar-item ${tab === "edit" ? "active" : ""}`}
        onClick={() => setTab("edit")}
      >
        <span className="icon">
          <Pencil size={14} />
        </span>
        <span className="label">지식 수정</span>
      </button>

      <div className="sidebar-section-label sidebar-recent-label">RECENT CHATS</div>
      {conversations.length === 0 ? (
        <div className="sidebar-empty">최근 대화가 없습니다</div>
      ) : (
        conversations.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`sidebar-recent ${
              tab === "chat" && activeConversationId === c.id ? "active" : ""
            }`}
            onClick={() => openConversation(c.id)}
          >
            <span>{c.title}</span>
          </button>
        ))
      )}
    </aside>
  );

  const topbarTitle =
    tab === "chat" ? "채팅" : tab === "browse" ? "지식 조회" : "지식 수정";
  const topbarSub =
    tab === "chat"
      ? "질문하면 인덱싱된 지식에서 답을 만들어드립니다"
      : tab === "browse"
      ? `${filteredItems.length}건 표시 · 전체 ${items.length}건`
      : !unlocked
      ? "비밀번호 입력"
      : editView === "ingest"
      ? "새 항목 추가"
      : selectedItem
      ? "선택한 항목 편집"
      : "좌측 목록에서 항목을 선택하세요";

  return (
    <div className="app">
      {sidebar}
      <main className="main">
        <header className="topbar">
          <button
            type="button"
            className="topbar-menu"
            onClick={() => setDrawerOpen(true)}
            aria-label="메뉴 열기"
          >
            <Menu size={20} />
          </button>
          <div className="topbar-brand">
            <div className="sidebar-name">Kingshot WIKI</div>
          </div>
          <div className="topbar-titles">
            <h1>{topbarTitle}</h1>
            <div className="sub">{topbarSub}</div>
          </div>
          <div className="topbar-actions">
            {tab === "browse" && (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => loadKnowledge()}>
                  <RefreshCw size={14} />새로고침
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    setTab("edit");
                    if (unlocked) {
                      setEditView("ingest");
                      setIngestSavedId(null);
                    }
                  }}
                >
                  <Plus size={14} />새 항목
                </button>
              </>
            )}
            {tab === "edit" && unlocked && (
              <>
                <button
                  className={`btn btn-sm ${
                    editView === "editor" ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() => setEditView("editor")}
                >
                  <ListChecks size={14} />
                  편집
                </button>
                <button
                  className={`btn btn-sm ${
                    editView === "ingest" ? "btn-primary" : "btn-secondary"
                  }`}
                  onClick={() => {
                    setEditView("ingest");
                    setIngestSavedId(null);
                  }}
                >
                  <Plus size={14} />새 항목
                </button>
              </>
            )}
          </div>
          <div className="topbar-mobile-actions">
            {tab === "chat" && (
              <button
                type="button"
                className="icon-btn"
                onClick={startNewChat}
                aria-label="새 채팅"
              >
                <Plus size={18} />
              </button>
            )}
            {tab === "browse" && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => loadKnowledge()}
                aria-label="새로고침"
              >
                <RefreshCw size={18} />
              </button>
            )}
            {tab === "edit" && unlocked && (
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  setEditView(editView === "ingest" ? "editor" : "ingest");
                  setIngestSavedId(null);
                }}
                aria-label={editView === "ingest" ? "편집" : "새 항목"}
              >
                {editView === "ingest" ? (
                  <ListChecks size={18} />
                ) : (
                  <Plus size={18} />
                )}
              </button>
            )}
          </div>
        </header>

        <section className="page-content">
          {tab === "chat" && (
            <ChatPanel
              messages={messages}
              composerValue={composerValue}
              onComposerChange={setComposerValue}
              onComposerKey={onComposerKey}
              onSubmit={() => void submitQuestion()}
              composerRef={composerRef}
              busy={chatBusy}
              error={chatError}
              onRetry={retryLast}
              onImageOpen={(image) => setImageModal({ url: image.url, name: image.id })}
              onSourceOpen={(source, index) => setCitationModal({ source, index })}
            />
          )}

          {tab === "browse" && (
            <BrowsePanel
              items={filteredItems}
              query={browseQuery}
              onQueryChange={setBrowseQuery}
              categories={categories}
              categoryId={browseCategoryId}
              onCategoryChange={setBrowseCategoryId}
              onOpen={openBrowseModal}
            />
          )}

          {tab === "edit" && !unlocked && (
            <LockPanel
              value={passwordInput}
              wrong={passwordWrong}
              onChange={(v) => {
                setPasswordInput(v);
                if (passwordWrong) setPasswordWrong(false);
              }}
              onSubmit={() => tryUnlock()}
            />
          )}

          {tab === "edit" && unlocked && editView === "editor" && (
            <EditPanel
              items={editFilteredItems}
              listQuery={editListQuery}
              onListQueryChange={setEditListQuery}
              selectedId={selectedId}
              selectedItem={selectedItem}
              draftTitle={draftTitle}
              draftSummary={draftSummary}
              draftBody={draftBody}
              draftTags={draftTags}
              tagDraft={tagDraft}
              draftCategoryId={draftCategoryId}
              categories={categories}
              busy={editBusy}
              error={editError}
              onSelect={(it) => selectItem(it)}
              onTitleChange={setDraftTitle}
              onSummaryChange={setDraftSummary}
              onBodyChange={setDraftBody}
              onTagDraftChange={setTagDraft}
              onTagAdd={addTag}
              onTagRemove={removeTag}
              onCategoryChange={setDraftCategoryId}
              onSave={saveSelected}
              onAskDelete={() => setConfirmDelete(true)}
              onNew={() => {
                setEditView("ingest");
                setIngestSavedId(null);
              }}
              onAssetOpen={(asset) =>
                setImageModal({ url: asset.gcs_url, name: asset.id })
              }
            />
          )}

          {tab === "edit" && unlocked && editView === "ingest" && (
            <IngestPanel
              body={ingestBody}
              onBodyChange={setIngestBody}
              sourceType={ingestSourceType}
              onSourceTypeChange={setIngestSourceType}
              images={ingestImages}
              previews={ingestPreviews}
              dragging={ingestDragging}
              onDragOver={(event) => {
                event.preventDefault();
                setIngestDragging(true);
              }}
              onDragLeave={() => setIngestDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIngestDragging(false);
                addIngestFiles(event.dataTransfer.files);
              }}
              onPick={(event) => addIngestFiles(event.target.files)}
              onRemove={removeIngestFile}
              busy={ingestBusy}
              savedId={ingestSavedId}
              error={ingestError}
              onSubmit={submitIngest}
            />
          )}
        </section>
        <div
          className={`drawer-backdrop ${drawerOpen ? "open" : ""}`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden={!drawerOpen}
        />
        <aside
          className={`drawer ${drawerOpen ? "open" : ""}`}
          aria-hidden={!drawerOpen}
        >
          {sidebar}
        </aside>
        <nav className="bottom-nav" aria-label="기본 메뉴">
          {[
            { id: "chat" as const, label: "채팅", icon: <MessageSquareText size={20} /> },
            { id: "browse" as const, label: "조회", icon: <Search size={20} /> },
            { id: "edit" as const, label: "수정", icon: <Pencil size={20} /> }
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              className={`bottom-nav-item ${tab === item.id ? "active" : ""}`}
              onClick={() => setTab(item.id)}
            >
              <span className="bottom-nav-icon">{item.icon}</span>
              <span className="bottom-nav-label">{item.label}</span>
              <span className="bottom-nav-indicator" />
            </button>
          ))}
        </nav>
      </main>

      {modalIndex !== null && filteredItems[modalIndex] && (
        <BrowseModal
          item={filteredItems[modalIndex]}
          index={modalIndex}
          total={filteredItems.length}
          onPrev={() => navModal(-1)}
          onNext={() => navModal(1)}
          onClose={closeBrowseModal}
          onEdit={editFromModal}
          onAssetOpen={(asset) => setImageModal({ url: asset.gcs_url, name: asset.id })}
        />
      )}

      {citationModal && (
        <CitationModal
          source={citationModal.source}
          index={citationModal.index}
          item={items.find((it) => it.id === citationModal.source.id) ?? null}
          onClose={() => setCitationModal(null)}
          onOpenItem={(item) => {
            setCitationModal(null);
            setBrowseQuery("");
            setBrowseCategoryId("");
            setTab("browse");
            const idx = items.findIndex((it) => it.id === item.id);
            if (idx >= 0) setModalIndex(idx);
          }}
        />
      )}

      {imageModal && (
        <div className="image-modal-backdrop" onClick={() => setImageModal(null)}>
          <div className="image-modal-inner" onClick={(event) => event.stopPropagation()}>
            <div className="image-modal-meta">
              <span>{imageModal.name ?? ""}</span>
              <button
                className="icon-btn"
                style={{ color: "#fff" }}
                onClick={() => setImageModal(null)}
                aria-label="닫기"
              >
                <X size={16} />
              </button>
            </div>
            <img src={imageModal.url} alt="" />
          </div>
        </div>
      )}

      {confirmDelete && selectedItem && (
        <div className="confirm" onClick={() => setConfirmDelete(false)}>
          <div className="confirm-card" onClick={(event) => event.stopPropagation()}>
            <div className="confirm-head">
              <div className="confirm-icon">
                <Trash2 size={14} />
              </div>
              <div className="confirm-title">이 항목을 삭제할까요?</div>
            </div>
            <div className="confirm-body">
              <strong>
                {selectedItem.id} · {selectedItem.title}
              </strong>
              <br />
              첨부 이미지 {selectedItem.assets.length}개가 함께 삭제됩니다. 되돌릴 수 없습니다.
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 10px",
                background: "var(--surface-alt)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r1)",
                marginBottom: 14
              }}
            >
              <span
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--ink-mute)"
                }}
              >
                확인
              </span>
              <input
                className="input mono"
                style={{
                  flex: 1,
                  padding: "4px 6px",
                  minHeight: 24,
                  background: "transparent",
                  border: 0
                }}
                value={deleteConfirmText}
                onChange={(event) => setDeleteConfirmText(event.target.value)}
                placeholder={selectedItem.id}
              />
            </div>
            <div className="confirm-actions">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  setConfirmDelete(false);
                  setDeleteConfirmText("");
                }}
              >
                취소
              </button>
              <button
                className="btn btn-danger-solid btn-sm"
                disabled={editBusy || deleteConfirmText !== selectedItem.id}
                onClick={() => void deleteSelected()}
              >
                <Trash2 size={14} />
                영구 삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Chat panel ─────────────────────────────────────────────────────────
function ChatPanel({
  messages,
  composerValue,
  onComposerChange,
  onComposerKey,
  onSubmit,
  composerRef,
  busy,
  error,
  onRetry,
  onImageOpen,
  onSourceOpen
}: {
  messages: ChatMessage[];
  composerValue: string;
  onComposerChange: (value: string) => void;
  onComposerKey: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
  composerRef: { current: HTMLTextAreaElement | null };
  busy: boolean;
  error: string | null;
  onRetry: () => void;
  onImageOpen: (image: ImageRef) => void;
  onSourceOpen: (source: Source, index: number) => void;
}) {
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages]);

  const empty = messages.length === 0;

  return (
    <div className="chat-page">
      {error && (
        <div className="error-banner">
          <span>
            <TriangleAlert size={14} />
          </span>
          <span className="error-banner-msg">{error}</span>
          <button className="btn btn-danger-solid btn-sm" onClick={onRetry} disabled={busy}>
            <RefreshCw size={14} />
            재시도
          </button>
        </div>
      )}

      {empty ? (
        <div className="chat-empty">
          <div className="chat-empty-inner">
            <div className="chat-empty-icon">
              <Sparkles size={20} />
            </div>
            <div className="chat-empty-title">새 대화를 시작하세요</div>
            <div className="chat-empty-sub">킹샷에 대해 궁금한 점을 물어보세요.</div>
            <div className="chat-empty-grid">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.t}
                  type="button"
                  className="chat-suggestion"
                  onClick={() => onComposerChange(s.t)}
                >
                  <strong>{s.t}</strong>
                  <span className="cat">{s.c}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="chat-thread" ref={threadRef}>
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="chat-user">
                <div className="chat-user-bubble">{m.content}</div>
              </div>
            ) : (
              <div key={m.id} className="chat-assistant">
                <div className="chat-avatar">K</div>
                <div className="chat-assistant-body">
                  <div className="chat-assistant-head">
                    <span className="chat-assistant-name">Kingshot WIKI</span>
                    {m.streaming && (
                      <span className="chat-streaming">
                        <span className="chat-streaming-dot" />
                        생성 중
                      </span>
                    )}
                    {m.errored && <span className="pill pill-danger">실패</span>}
                  </div>
                  <div className="chat-message-content">
                    {m.content ? (
                      <ReactMarkdown remarkPlugins={MD_PLUGINS}>{m.content}</ReactMarkdown>
                    ) : m.errored ? (
                      <em style={{ color: "var(--ink-soft)" }}>응답을 가져오지 못했습니다.</em>
                    ) : (
                      <span style={{ color: "var(--ink-mute)" }}>답변을 준비하는 중…</span>
                    )}
                    {m.streaming && <span className="stream-cursor" />}
                  </div>
                  {m.images && m.images.length > 0 && (
                    <div className="assistant-images">
                      {m.images.map((image) => (
                        <button
                          key={image.id}
                          type="button"
                          className="assistant-image-btn"
                          onClick={() => onImageOpen(image)}
                        >
                          <img src={image.url} alt="" />
                        </button>
                      ))}
                    </div>
                  )}
                  {m.sources && m.sources.length > 0 && (
                    <div className="assistant-sources">
                      {m.sources.map((source, index) => (
                        <button
                          key={source.id}
                          type="button"
                          className="source-chip"
                          onClick={() => onSourceOpen(source, index)}
                        >
                          <span className="source-chip-num">{index + 1}</span>
                          <span className="source-chip-title">{source.title}</span>
                          <span className="source-chip-score">
                            {Math.round(source.similarity * 100)}%
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      )}

      <div className={`composer ${error ? "disabled" : ""}`}>
        <textarea
          ref={composerRef}
          rows={1}
          value={composerValue}
          onChange={(event) => onComposerChange(event.target.value)}
          onKeyDown={onComposerKey}
          placeholder={PLACEHOLDER}
          disabled={Boolean(error)}
        />
        <button
          className="btn btn-accent btn-sm"
          onClick={onSubmit}
          disabled={Boolean(error) || busy || composerValue.trim().length === 0}
        >
          {busy ? <span className="spinner" /> : <Send size={14} />}
          전송
        </button>
      </div>
    </div>
  );
}

// ─── Browse panel ──────────────────────────────────────────────────────
function BrowsePanel({
  items,
  query,
  onQueryChange,
  categories,
  categoryId,
  onCategoryChange,
  onOpen
}: {
  items: KnowledgeItem[];
  query: string;
  onQueryChange: (value: string) => void;
  categories: Category[];
  categoryId: string;
  onCategoryChange: (value: string) => void;
  onOpen: (index: number) => void;
}) {
  return (
    <>
      <div className="browse-toolbar">
        <div className="browse-filters">
          <div className="browse-search">
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => onQueryChange(event.target.value)}
              placeholder="지식 검색"
            />
          </div>
          <select
            className="select"
            style={{ width: 180 }}
            value={categoryId}
            onChange={(event) => onCategoryChange(event.target.value)}
          >
            <option value="">전체 카테고리</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {items.length === 0 ? (
        <div className="browse-empty">
          <div className="browse-empty-inner">
            <div className="browse-empty-icon">
              <Search size={18} />
            </div>
            <div className="browse-empty-title">검색 결과가 없습니다</div>
            <div className="browse-empty-sub">
              검색어 또는 필터를 바꿔보거나, 새 항목을 추가하세요.
            </div>
            <div className="browse-empty-actions">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  onQueryChange("");
                  onCategoryChange("");
                }}
              >
                필터 초기화
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="browse-table">
          <div className="browse-row head">
            <span>제목</span>
            <span>출처</span>
            <span>카테고리</span>
            <span>태그</span>
            <span className="right">첨부</span>
          </div>
          <div className="browse-list">
            {items.map((it, index) => (
              <button
                key={it.id}
                type="button"
                className="browse-row"
                onClick={() => onOpen(index)}
              >
                <div className="title">
                  <strong>{it.title}</strong>
                  <small>{it.summary}</small>
                </div>
                <div className="source">{getSourceLabel(it.source_type)}</div>
                <div className="cat">{it.category?.name ?? "미분류"}</div>
                <div className="tags">
                  {it.tags.slice(0, 2).map((t) => (
                    <span key={t} className="pill">
                      #{t}
                    </span>
                  ))}
                  {it.tags.length > 2 && (
                    <span className="tags-more">+{it.tags.length - 2}</span>
                  )}
                </div>
                <div className="right">{it.assets.length}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ─── Browse modal ──────────────────────────────────────────────────────
function BrowseModal({
  item,
  index,
  total,
  onPrev,
  onNext,
  onClose,
  onEdit,
  onAssetOpen
}: {
  item: KnowledgeItem;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onEdit: () => void;
  onAssetOpen: (asset: KnowledgeItem["assets"][number]) => void;
}) {
  const atFirst = index === 0;
  const atLast = index === total - 1;
  return (
    <>
      <div className="modal-backdrop" onClick={onClose} />
      <button
        className="nav-arrow left"
        onClick={onPrev}
        disabled={atFirst}
        aria-label="이전"
      >
        <ChevronLeft size={20} />
      </button>
      <button
        className="nav-arrow right"
        onClick={onNext}
        disabled={atLast}
        aria-label="다음"
      >
        <ChevronRight size={20} />
      </button>
      <div className="modal" role="dialog" aria-modal>
        <div className="modal-head">
          <div className="modal-head-left">
            <span className="pill pill-accent">{item.category?.name ?? "미분류"}</span>
            <span className="modal-id modal-id-uuid">{item.id}</span>
            <span className="modal-id">
              {index + 1} / {total}
            </span>
          </div>
          <div className="modal-head-right">
            <button className="btn btn-secondary btn-sm" onClick={onEdit}>
              <Pencil size={14} />
              편집
            </button>
            <button className="icon-btn" onClick={onClose} aria-label="닫기">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="modal-body">
          <div className="modal-title">{item.title}</div>
          <div className="modal-meta">
            {getSourceLabel(item.source_type)} · {item.assets.length} ATTACHMENTS · {item.tags.length} TAGS
          </div>
          <div className="chat-message-content">
            <ReactMarkdown remarkPlugins={MD_PLUGINS}>
              {item.body || item.summary}
            </ReactMarkdown>
          </div>
          {item.assets.length > 0 && (
            <div className="modal-images">
              {item.assets.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  className="asset-strip-item"
                  style={{ width: 200, height: 132 }}
                  onClick={() => onAssetOpen(asset)}
                >
                  <img src={asset.gcs_url} alt="" />
                </button>
              ))}
            </div>
          )}
          <div className="modal-section-label">METADATA</div>
          <div className="modal-meta-grid">
            <div className="key">카테고리</div>
            <div>{item.category?.name ?? "미분류"}</div>
            <div className="key">출처</div>
            <div>{getSourceLabel(item.source_type)}</div>
            <div className="key">태그</div>
            <div className="tags">
              {item.tags.length === 0 ? (
                <span style={{ color: "var(--ink-mute)" }}>—</span>
              ) : (
                item.tags.map((t) => (
                  <span key={t} className="pill">
                    #{t}
                  </span>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <span className="modal-foot-hint">← 이전 · → 다음 · ESC 닫기</span>
          <div className="modal-foot-buttons">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onPrev}
              disabled={atFirst}
            >
              <ChevronLeft size={14} />
              이전
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onNext}
              disabled={atLast}
            >
              다음
              <ChevronRight size={14} />
            </button>
          </div>
          <span className="modal-foot-count">
            {index + 1} / {total}
          </span>
        </div>
      </div>
    </>
  );
}

// ─── Edit lock ─────────────────────────────────────────────────────────
function LockPanel({
  value,
  wrong,
  onChange,
  onSubmit
}: {
  value: string;
  wrong: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="lock-page">
      <div className="lock-card">
        <div className="lock-icon">
          <Lock size={18} />
        </div>
        <div className="lock-title">
          <strong>지식 수정 · 잠금</strong>
          <small>운영자 비밀번호를 입력해야 수정 영역에 접근할 수 있습니다.</small>
        </div>
        <div className="field">
          <div className="field-head">
            <span className="field-label">비밀번호</span>
          </div>
          <input
            type="password"
            className={`lock-input ${wrong ? "wrong" : ""}`}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
            }}
            placeholder="••••••••"
            autoFocus
          />
        </div>
        {wrong && (
          <div className="lock-error">
            <TriangleAlert size={14} />
            비밀번호가 일치하지 않습니다.
          </div>
        )}
        <button className="btn btn-primary btn-full" onClick={onSubmit}>
          잠금 해제
        </button>
      </div>
    </div>
  );
}

// ─── Edit panel ────────────────────────────────────────────────────────
function EditPanel(props: {
  items: KnowledgeItem[];
  listQuery: string;
  onListQueryChange: (value: string) => void;
  selectedId: string;
  selectedItem: KnowledgeItem | null;
  draftTitle: string;
  draftSummary: string;
  draftBody: string;
  draftTags: string[];
  tagDraft: string;
  draftCategoryId: string;
  categories: Category[];
  busy: boolean;
  error: string | null;
  onSelect: (item: KnowledgeItem) => void;
  onTitleChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onBodyChange: (value: string) => void;
  onTagDraftChange: (value: string) => void;
  onTagAdd: () => void;
  onTagRemove: (tag: string) => void;
  onCategoryChange: (value: string) => void;
  onSave: () => void;
  onAskDelete: () => void;
  onNew: () => void;
  onAssetOpen: (asset: KnowledgeItem["assets"][number]) => void;
}) {
  const {
    items,
    listQuery,
    onListQueryChange,
    selectedId,
    selectedItem,
    draftTitle,
    draftSummary,
    draftBody,
    draftTags,
    tagDraft,
    draftCategoryId,
    categories,
    busy,
    error,
    onSelect,
    onTitleChange,
    onSummaryChange,
    onBodyChange,
    onTagDraftChange,
    onTagAdd,
    onTagRemove,
    onCategoryChange,
    onSave,
    onAskDelete,
    onNew,
    onAssetOpen
  } = props;

  const dirty =
    selectedItem !== null &&
    (selectedItem.title !== draftTitle ||
      selectedItem.summary !== draftSummary ||
      selectedItem.body !== draftBody ||
      selectedItem.tags.join(",") !== draftTags.join(",") ||
      (selectedItem.category?.id ?? "") !== draftCategoryId);

  return (
    <div className="edit-two">
      <div className="edit-list">
        <div className="edit-list-head">
          <div className="edit-list-search">
            <Search size={14} />
            <input
              value={listQuery}
              onChange={(event) => onListQueryChange(event.target.value)}
              placeholder="목록 검색"
            />
          </div>
        </div>
        <div className="edit-list-rows">
          {items.length === 0 && (
            <div className="sidebar-empty">목록에 표시할 항목이 없습니다</div>
          )}
          {items.map((it) => (
            <button
              key={it.id}
              type="button"
              className={`edit-row ${it.id === selectedId ? "active" : ""}`}
              onClick={() => onSelect(it)}
            >
              <div className="title">
                <strong>{it.title}</strong>
                <small>{it.category?.name ?? "미분류"}</small>
              </div>
            </button>
          ))}
        </div>
        <div className="edit-list-foot">
          <button className="btn btn-secondary btn-sm btn-full" onClick={onNew}>
            <Plus size={14} />새 항목
          </button>
        </div>
      </div>

      <div className="edit-form-shell">
        {!selectedItem ? (
          <div className="empty-state">
            <div className="empty-state-inner">
              <div className="empty-state-icon">
                <Save size={20} />
              </div>
              <div className="empty-state-title">편집할 항목 선택</div>
              <div className="empty-state-sub">
                왼쪽 목록에서 클릭하면 본문, 메타데이터, 첨부 이미지를 수정할 수 있습니다.
              </div>
              <div className="empty-state-action">
                <button className="btn btn-primary btn-sm" onClick={onNew}>
                  <Plus size={14} />새 항목 만들기
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="edit-form-head">
              <div className="edit-form-head-left">
                <span className="modal-id">{selectedItem.id}</span>
                {dirty && <span className="pill pill-warn">미저장 변경</span>}
              </div>
              <div className="edit-form-head-right">
                <button
                  className="btn btn-danger btn-sm"
                  onClick={onAskDelete}
                  disabled={busy}
                >
                  <Trash2 size={14} />
                  삭제
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={onSave}
                  disabled={busy || !dirty}
                >
                  {busy ? <span className="spinner" /> : <Save size={14} />}
                  {busy ? "저장 중" : "변경 저장"}
                </button>
              </div>
            </div>
            <div className="edit-form-body">
              {error && (
                <div className="error-banner">
                  <span>
                    <TriangleAlert size={14} />
                  </span>
                  <span className="error-banner-msg">{error}</span>
                </div>
              )}
              <div className="field">
                <div className="field-head">
                  <span className="field-label">제목</span>
                </div>
                <input
                  className="input"
                  value={draftTitle}
                  onChange={(event) => onTitleChange(event.target.value)}
                />
              </div>
              <div className="field">
                <div className="field-head">
                  <span className="field-label">요약</span>
                  <span className="field-hint">응답 시 기본으로 노출됩니다 · 최대 160자</span>
                </div>
                <textarea
                  className="textarea"
                  style={{ minHeight: 64 }}
                  value={draftSummary}
                  onChange={(event) => onSummaryChange(event.target.value)}
                  maxLength={200}
                />
              </div>
              <div className="field">
                <div className="field-head">
                  <span className="field-label">본문</span>
                  <span className="field-hint" style={{ fontFamily: "var(--mono)" }}>
                    MD · {draftBody.length}자
                  </span>
                </div>
                <textarea
                  className="textarea"
                  style={{ minHeight: 220 }}
                  value={draftBody}
                  onChange={(event) => onBodyChange(event.target.value)}
                />
              </div>
              <div className="field-grid">
                <div className="field">
                  <div className="field-head">
                    <span className="field-label">카테고리</span>
                  </div>
                  <select
                    className="select"
                    value={draftCategoryId}
                    onChange={(event) => onCategoryChange(event.target.value)}
                  >
                    <option value="">미분류</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <div className="field-head">
                    <span className="field-label">ID</span>
                  </div>
                  <input
                    className="input mono"
                    value={selectedItem.id}
                    readOnly
                    style={{ background: "var(--surface-alt)" }}
                  />
                </div>
              </div>
              <div className="field">
                <div className="field-head">
                  <span className="field-label">태그</span>
                </div>
                <div className="tag-input">
                  {draftTags.map((t) => (
                    <span key={t} className="tag-chip">
                      #{t}
                      <button
                        type="button"
                        className="tag-chip-x"
                        onClick={() => onTagRemove(t)}
                        aria-label="태그 제거"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  <input
                    value={tagDraft}
                    onChange={(event) => onTagDraftChange(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === ",") {
                        event.preventDefault();
                        onTagAdd();
                      }
                      if (
                        event.key === "Backspace" &&
                        tagDraft.length === 0 &&
                        draftTags.length > 0
                      ) {
                        onTagRemove(draftTags[draftTags.length - 1]);
                      }
                    }}
                    onBlur={onTagAdd}
                    placeholder={draftTags.length === 0 ? "태그를 입력하고 Enter" : "+ 태그 추가"}
                  />
                </div>
              </div>
              <div className="field">
                <div className="field-head">
                  <span className="field-label">첨부 이미지</span>
                </div>
                {selectedItem.assets.length === 0 ? (
                  <div style={{ fontSize: 12, color: "var(--ink-mute)" }}>
                    첨부된 이미지가 없습니다
                  </div>
                ) : (
                  <div className="asset-strip">
                    {selectedItem.assets.map((asset) => (
                      <button
                        key={asset.id}
                        type="button"
                        className="asset-strip-item"
                        onClick={() => onAssetOpen(asset)}
                      >
                        <img src={asset.gcs_url} alt="" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Citation modal ───────────────────────────────────────────────────
function CitationModal({
  source,
  index,
  item,
  onClose,
  onOpenItem
}: {
  source: Source;
  index: number;
  item: KnowledgeItem | null;
  onClose: () => void;
  onOpenItem: (item: KnowledgeItem) => void;
}) {
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tags = item?.tags ?? [];
  const categoryName = item?.category?.name;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-card"
        role="dialog"
        aria-modal
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="dialog-close"
          onClick={onClose}
          aria-label="닫기"
        >
          <X size={16} />
        </button>
        <div className="citation-head">
          <span className="citation-num">{index + 1}</span>
          {categoryName ? (
            <span className="pill pill-accent">{categoryName}</span>
          ) : (
            <span className="pill">인용</span>
          )}
          <span className="citation-score">
            유사도 {Math.round(source.similarity * 100)}%
          </span>
        </div>
        <div className="citation-title">{source.title}</div>
        <p className="citation-summary">{source.summary}</p>
        {tags.length > 0 && (
          <div className="citation-tags">
            {tags.map((t) => (
              <span key={t} className="pill">
                #{t}
              </span>
            ))}
          </div>
        )}
        <div className="citation-actions">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose}>
            닫기
          </button>
          {item && (
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => onOpenItem(item)}
            >
              전체 보기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Ingest panel ──────────────────────────────────────────────────────
function IngestPanel({
  body,
  onBodyChange,
  sourceType,
  onSourceTypeChange,
  images,
  previews,
  dragging,
  onDragOver,
  onDragLeave,
  onDrop,
  onPick,
  onRemove,
  busy,
  savedId,
  error,
  onSubmit
}: {
  body: string;
  onBodyChange: (value: string) => void;
  sourceType: KnowledgeSourceType;
  onSourceTypeChange: (value: KnowledgeSourceType) => void;
  images: File[];
  previews: string[];
  dragging: boolean;
  onDragOver: (event: DragEvent<HTMLLabelElement>) => void;
  onDragLeave: () => void;
  onDrop: (event: DragEvent<HTMLLabelElement>) => void;
  onPick: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemove: (index: number) => void;
  busy: boolean;
  savedId: string | null;
  error: string | null;
  onSubmit: () => void;
}) {
  const submittable = !busy && (body.trim().length > 0 || images.length > 0);
  return (
    <div className="ingest-page">
      <div className="ingest-card">
        <div className="ingest-head">
          <h2>새 항목 추가</h2>
          <span className="ingest-hint">제목·태그·카테고리는 저장 시 자동 생성됩니다</span>
        </div>

        {error && (
          <div className="error-banner">
            <span>
              <TriangleAlert size={14} />
            </span>
            <span className="error-banner-msg">{error}</span>
          </div>
        )}

        <div className="field">
          <div className="field-head">
            <span className="field-label">출처</span>
          </div>
          <select
            className="select"
            value={sourceType}
            onChange={(event) => onSourceTypeChange(event.target.value as KnowledgeSourceType)}
          >
            <option value="ai">AI</option>
            <option value="swalove">스왈로브</option>
          </select>
        </div>

        <div className="field">
          <div className="field-head">
            <span className="field-label">설명</span>
          </div>
          <textarea
            className="textarea"
            value={body}
            onChange={(event) => onBodyChange(event.target.value)}
            placeholder="이미지에서 보이는 내용, 보상표 해석, 운영 팁 등을 입력"
          />
        </div>

        <div className="field">
          <div className="field-head">
            <span className="field-label">이미지</span>
          </div>
          <label
            className={`dropzone ${dragging ? "dragging" : ""}`}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <span className="icon">
              <ImageIcon size={20} />
            </span>
            <span className="title">
              {dragging ? "여기에 놓으세요" : "이미지를 드롭하거나 클릭"}
            </span>
            <span className="sub">PNG · JPG · WebP · 최대 10MB · 다중 가능</span>
            <input type="file" accept="image/*" multiple onChange={onPick} />
            {previews.length > 0 && !dragging && (
              <div className="dropzone-previews">
                {previews.map((url, index) => (
                  <div key={url} className="dropzone-thumb">
                    <img src={url} alt="" />
                    <button
                      type="button"
                      className="dropzone-thumb-x"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onRemove(index);
                      }}
                      aria-label="이미지 제거"
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </label>
        </div>

        <button
          type="button"
          className="btn btn-accent btn-full"
          onClick={onSubmit}
          disabled={!submittable}
        >
          {busy ? <span className="spinner" /> : <Save size={14} />}
          {busy ? "저장 중…" : "저장"}
        </button>

        {savedId !== null && (
          <div className="success-banner">
            <span className="success-check">✓</span>
            {savedId ? `${savedId} 로 저장되었습니다` : "저장되었습니다"}
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
