import { BrowserControlScopeError } from "./agent-window";

const NOTES_KEY = "browserControl.agentNotes";
const MAX_TEXT = 2000;
const MAX_NOTES = 200;
const RETENTION = 7 * 24 * 60 * 60 * 1000;
const KINDS = ["info", "needs-human", "done"] as const;

export type AgentNoteKind = (typeof KINDS)[number];
export type AgentNoteStatus = "open" | "acknowledged" | "resolved";
// 代理留给人工的页面级便签；按网址保存，标签关闭或浏览器重启后仍保留
export type AgentNote = {
  id: string;
  url: string;
  title?: string;
  sessionId: string;
  label?: string;
  kind: AgentNoteKind;
  text: string;
  status: AgentNoteStatus;
  reply?: string;
  createdAt: number;
  updatedAt: number;
};
export type AgentNoteDraft = Pick<AgentNote, "url" | "title" | "sessionId" | "label" | "kind" | "text">;
export type AgentNoteFilter = { url?: string; sessionId?: string; status?: AgentNoteStatus };
export type AgentNotesListener = (notes: AgentNote[]) => void;

export interface AgentNotesDependencies {
  load(): Promise<AgentNote[] | undefined>;
  save(notes: AgentNote[]): Promise<void>;
  id(): string;
  now(): number;
}

function invalid(message: string): BrowserControlScopeError {
  return new BrowserControlScopeError("INVALID_NOTE", message);
}

function noteText(text: unknown, field: string): string {
  const value = typeof text === "string" ? text.trim().slice(0, MAX_TEXT) : "";
  if (!value) throw invalid(`${field} must not be empty`);
  return value;
}

// 页面级锚点：同一页面不同锚点视为同一页面
export function noteUrl(url: string): string {
  return url.split("#", 1)[0];
}

export class AgentNotesService {
  private pending: Promise<void> = Promise.resolve();
  private listeners = new Set<AgentNotesListener>();

  constructor(private readonly deps: AgentNotesDependencies) {}

  private async withNotes<T>(action: (notes: AgentNote[]) => T, mutates: boolean): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const cutoff = this.deps.now() - RETENTION;
      const notes = ((await this.deps.load()) ?? []).filter((note) => note.updatedAt > cutoff);
      const result = action(notes);
      if (mutates) {
        const kept = notes.slice(-MAX_NOTES);
        await this.deps.save(kept);
        for (const listener of this.listeners) listener(kept);
      }
      return result;
    } finally {
      release();
    }
  }

  private find(notes: AgentNote[], id: string): AgentNote {
    const note = notes.find((item) => item.id === id);
    if (!note) throw new BrowserControlScopeError("NOTE_NOT_FOUND", "Note not found or expired");
    return note;
  }

  private update(id: string, change: (note: AgentNote) => void): Promise<AgentNote> {
    return this.withNotes((notes) => {
      const note = this.find(notes, id);
      change(note);
      note.updatedAt = this.deps.now();
      return { ...note };
    }, true);
  }

  async add(draft: AgentNoteDraft): Promise<AgentNote> {
    if (!KINDS.includes(draft.kind)) throw invalid(`kind must be one of ${KINDS.join(", ")}`);
    const text = noteText(draft.text, "text");
    return this.withNotes((notes) => {
      const now = this.deps.now();
      const note: AgentNote = {
        id: this.deps.id(),
        url: noteUrl(draft.url),
        ...(draft.title ? { title: draft.title } : {}),
        sessionId: draft.sessionId,
        ...(draft.label ? { label: draft.label } : {}),
        kind: draft.kind,
        text,
        status: "open",
        createdAt: now,
        updatedAt: now,
      };
      notes.push(note);
      return { ...note };
    }, true);
  }

  get(id: string): Promise<AgentNote> {
    return this.withNotes((notes) => ({ ...this.find(notes, id) }), false);
  }

  list({ url, sessionId, status }: AgentNoteFilter): Promise<AgentNote[]> {
    const page = url === undefined ? undefined : noteUrl(url);
    return this.withNotes(
      (notes) =>
        notes.filter(
          (note) =>
            (page === undefined || note.url === page) &&
            (sessionId === undefined || note.sessionId === sessionId) &&
            (status === undefined || note.status === status)
        ),
      false
    );
  }

  acknowledge(id: string): Promise<AgentNote> {
    return this.update(id, (note) => {
      if (note.status === "open") note.status = "acknowledged";
    });
  }

  async reply(id: string, text: string): Promise<AgentNote> {
    const reply = noteText(text, "reply");
    return this.update(id, (note) => {
      note.reply = reply;
      if (note.status === "open") note.status = "acknowledged";
    });
  }

  resolve(id: string): Promise<AgentNote> {
    return this.update(id, (note) => {
      note.status = "resolved";
    });
  }

  async remove(id: string): Promise<void> {
    await this.withNotes((notes) => {
      notes.splice(notes.indexOf(this.find(notes, id)), 1);
    }, true);
  }

  subscribe(listener: AgentNotesListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const agentNotesService = new AgentNotesService({
  load: async () => (await chrome.storage.local.get(NOTES_KEY))[NOTES_KEY] as AgentNote[] | undefined,
  save: async (notes) => {
    await chrome.storage.local.set({ [NOTES_KEY]: notes });
  },
  id: () => crypto.randomUUID(),
  now: () => Date.now(),
});
