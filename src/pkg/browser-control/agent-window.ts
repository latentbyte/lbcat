const STATE_KEY = "browserControl.agentWindow";
const DEFAULT_TTL = 15 * 60 * 1000;
const MAX_TTL = 24 * 60 * 60 * 1000;

export type AgentWindowStatus = { windowId: number; markerTabId: number };
type Registration = AgentWindowStatus & { markerUrl: string };
type Session = { sessionId: string; expiresAt: number; ttlMs: number; paused: boolean; tabIds: number[] };
type State = { registration?: Registration; sessions: Session[] };

export interface AgentWindowScope {
  status(): Promise<AgentWindowStatus>;
  assertWindowTab(tabId: number): Promise<chrome.tabs.Tab>;
}

export interface AgentBrowserTaskScope extends AgentWindowScope {
  createTab(url: string): Promise<chrome.tabs.Tab>;
  listTabs(): Promise<chrome.tabs.Tab[]>;
}

export interface AgentWindowDependencies {
  load(): Promise<unknown>;
  save(state: State): Promise<void>;
  markerUrl(): string;
  id(): string;
  now(): number;
  getTab(tabId: number): Promise<chrome.tabs.Tab>;
  listTabs(windowId: number): Promise<chrome.tabs.Tab[]>;
  createTab(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  getWindow(windowId: number): Promise<chrome.windows.Window>;
  listWindows(): Promise<chrome.windows.Window[]>;
  createWindow(properties: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>;
  pinTab(tabId: number): Promise<void>;
}

export class BrowserControlScopeError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "BrowserControlScopeError";
  }
}

function missingWindow(): BrowserControlScopeError {
  return new BrowserControlScopeError("AGENT_WINDOW_MISSING", "Open or designate the agent window before continuing");
}

export class AgentWindowService implements AgentWindowScope {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AgentWindowDependencies) {}

  // 原子更新窗口登记与任务租约，避免并发请求覆盖存储
  private async withState<T>(action: (state: State) => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      const saved = await this.deps.load();
      const state = saved ? (saved as State) : { sessions: [] };
      const result = await action(state);
      await this.deps.save(state);
      return result;
    } finally {
      release();
    }
  }

  private async registration(state: State): Promise<Registration> {
    const registration = state.registration;
    if (!registration) throw missingWindow();
    let marker: chrome.tabs.Tab;
    try {
      marker = await this.deps.getTab(registration.markerTabId);
    } catch {
      throw missingWindow();
    }
    if (marker.windowId !== registration.windowId || marker.url !== registration.markerUrl) throw missingWindow();
    return registration;
  }

  async status(): Promise<AgentWindowStatus> {
    return this.withState(async (state) => {
      const { windowId, markerTabId } = await this.registration(state);
      return { windowId, markerTabId };
    });
  }

  async listWindows(): Promise<Array<{ id: number; focused: boolean; type: chrome.windows.Window["type"] }>> {
    return (await this.deps.listWindows())
      .filter((window) => window.id !== undefined && !window.incognito && window.type === "normal")
      .map((window) => ({ id: window.id!, focused: window.focused, type: window.type }));
  }

  async create(): Promise<AgentWindowStatus> {
    return this.withState(async (state) => {
      const markerUrl = this.deps.markerUrl() + "?registration=" + this.deps.id();
      const window = await this.deps.createWindow({ url: markerUrl, focused: false, type: "normal" });
      const tab = window?.tabs?.[0];
      if (window?.id === undefined || tab?.id === undefined) throw new Error("Could not create agent window marker");
      await this.deps.pinTab(tab.id);
      state.registration = { windowId: window.id, markerTabId: tab.id, markerUrl };
      state.sessions = [];
      return { windowId: window.id, markerTabId: tab.id };
    });
  }

  async designate(windowId: number): Promise<AgentWindowStatus> {
    return this.withState(async (state) => {
      const window = await this.deps.getWindow(windowId);
      if (window.incognito || window.type !== "normal") {
        throw new BrowserControlScopeError(
          "INVALID_AGENT_WINDOW",
          "Agent window must be a normal, non-incognito window"
        );
      }
      const markerUrl = this.deps.markerUrl() + "?registration=" + this.deps.id();
      const marker = await this.deps.createTab({ windowId, url: markerUrl, active: false, pinned: true });
      if (marker.id === undefined) throw new Error("Could not create agent window marker");
      state.registration = { windowId, markerTabId: marker.id, markerUrl };
      state.sessions = [];
      return { windowId, markerTabId: marker.id };
    });
  }

  async clear(): Promise<void> {
    await this.withState(async (state) => {
      delete state.registration;
      state.sessions = [];
    });
  }

  private session(state: State, sessionId: string | undefined, allowPaused = false): Session {
    if (!sessionId)
      throw new BrowserControlScopeError("SESSION_REQUIRED", "Begin a browser task and pass its session ID");
    const session = state.sessions.find((item) => item.sessionId === sessionId);
    if (!session || session.expiresAt <= this.deps.now()) {
      throw new BrowserControlScopeError("SESSION_EXPIRED", "Browser task session expired; begin a new task");
    }
    if (session.paused && !allowPaused) throw new BrowserControlScopeError("SESSION_PAUSED", "Browser task is paused");
    return session;
  }

  async openSession(ttlMs = DEFAULT_TTL): Promise<{ sessionId: string; expiresAt: number }> {
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL)
      throw new Error("Session TTL must be between 1s and 24h");
    return this.withState(async (state) => {
      await this.registration(state);
      state.sessions = state.sessions.filter((item) => item.expiresAt > this.deps.now());
      const session: Session = {
        sessionId: this.deps.id(),
        expiresAt: this.deps.now() + ttlMs,
        ttlMs,
        paused: false,
        tabIds: [],
      };
      state.sessions.push(session);
      return { sessionId: session.sessionId, expiresAt: session.expiresAt };
    });
  }

  async renewSession(sessionId: string): Promise<{ expiresAt: number }> {
    return this.withState(async (state) => {
      await this.registration(state);
      const session = this.session(state, sessionId);
      session.expiresAt = this.deps.now() + session.ttlMs;
      return { expiresAt: session.expiresAt };
    });
  }

  async pauseSession(sessionId: string): Promise<void> {
    await this.withState(async (state) => {
      this.session(state, sessionId, true).paused = true;
    });
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.withState(async (state) => {
      await this.registration(state);
      this.session(state, sessionId, true).paused = false;
    });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.withState(async (state) => {
      state.sessions = state.sessions.filter((item) => item.sessionId !== sessionId);
    });
  }

  async listSessions(): Promise<Array<{ sessionId: string; expiresAt: number; paused: boolean; tabIds: number[] }>> {
    return this.withState(async (state) => {
      await this.registration(state);
      return state.sessions
        .filter((session) => session.expiresAt > this.deps.now())
        .map(({ sessionId, expiresAt, paused, tabIds }) => ({ sessionId, expiresAt, paused, tabIds: [...tabIds] }));
    });
  }

  private owner(state: State, tabId: number): Session | undefined {
    return state.sessions.find((item) => item.expiresAt > this.deps.now() && item.tabIds.includes(tabId));
  }

  private async windowTab(state: State, tabId: number, personalTabId?: number): Promise<chrome.tabs.Tab> {
    const registration = await this.registration(state);
    if (tabId === registration.markerTabId) {
      throw new BrowserControlScopeError("AGENT_MARKER_PROTECTED", "Agent window marker is not a work tab");
    }
    const tab = await this.deps.getTab(tabId);
    if (tab.windowId !== registration.windowId && personalTabId !== tabId) {
      throw new BrowserControlScopeError(
        "PERSONAL_TAB_DENIED",
        "Tab is outside the agent window; explicit per-tab permission required"
      );
    }
    return tab;
  }

  async assertWindowTab(tabId: number): Promise<chrome.tabs.Tab> {
    return this.withState(async (state) => {
      const tab = await this.windowTab(state, tabId);
      if (this.owner(state, tabId))
        throw new BrowserControlScopeError("TAB_BUSY", "Tab belongs to another browser task");
      return tab;
    });
  }

  async assertTabAccess(tabId: number, sessionId?: string, personalTabId?: number): Promise<chrome.tabs.Tab> {
    return this.withState(async (state) => {
      await this.registration(state);
      const session = this.session(state, sessionId);
      const tab = await this.windowTab(state, tabId, personalTabId);
      const owner = this.owner(state, tabId);
      if (owner && owner.sessionId !== sessionId)
        throw new BrowserControlScopeError("TAB_BUSY", "Tab belongs to another browser task");
      if (!session.tabIds.includes(tabId)) session.tabIds.push(tabId);
      session.expiresAt = this.deps.now() + session.ttlMs;
      return tab;
    });
  }

  async createTab(sessionId: string | undefined, url: string): Promise<chrome.tabs.Tab> {
    return this.withState(async (state) => {
      const registration = await this.registration(state);
      const session = this.session(state, sessionId);
      const tab = await this.deps.createTab({ windowId: registration.windowId, url, active: false });
      if (tab.id === undefined) throw new Error("Could not create browser task tab");
      session.tabIds.push(tab.id);
      session.expiresAt = this.deps.now() + session.ttlMs;
      return tab;
    });
  }

  async listTabs(sessionId?: string): Promise<chrome.tabs.Tab[]> {
    return this.withState(async (state) => {
      const registration = await this.registration(state);
      if (sessionId) this.session(state, sessionId).expiresAt = this.deps.now() + this.session(state, sessionId).ttlMs;
      const tabs = await this.deps.listTabs(registration.windowId);
      return tabs.filter((tab) => {
        if (tab.id === undefined || tab.id === registration.markerTabId) return false;
        const owner = this.owner(state, tab.id);
        return !owner || owner.sessionId === sessionId;
      });
    });
  }
}

export const agentWindowService = new AgentWindowService({
  load: async () => (await chrome.storage.local.get(STATE_KEY))[STATE_KEY],
  save: async (state) => chrome.storage.local.set({ [STATE_KEY]: state }),
  markerUrl: () => chrome.runtime.getURL("src/agent-window.html"),
  id: () => crypto.randomUUID(),
  now: () => Date.now(),
  getTab: (tabId) => chrome.tabs.get(tabId),
  listTabs: (windowId) => chrome.tabs.query({ windowId }),
  createTab: (properties) => chrome.tabs.create(properties),
  getWindow: (windowId) => chrome.windows.get(windowId),
  listWindows: () => chrome.windows.getAll({ windowTypes: ["normal"] }),
  createWindow: (properties) => chrome.windows.create(properties),
  pinTab: async (tabId) => {
    await chrome.tabs.update(tabId, { pinned: true });
  },
});

// 每次聊天、任务或子代理独立持有租约，不共享全局工具的标签权限
export class AgentTaskWindowScope implements AgentBrowserTaskScope {
  private closed = false;
  private sessionId: Promise<string> | undefined;

  constructor(private readonly service: AgentWindowService = agentWindowService) {}

  private session(): Promise<string> {
    if (this.closed) throw new BrowserControlScopeError("SESSION_CLOSED", "Browser task has ended");
    if (!this.sessionId) {
      this.sessionId = this.service
        .openSession()
        .then(({ sessionId }) => sessionId)
        .catch((error: unknown) => {
          this.sessionId = undefined;
          throw error;
        });
    }
    return this.sessionId;
  }

  status(): Promise<AgentWindowStatus> {
    return this.service.status();
  }

  async assertWindowTab(tabId: number): Promise<chrome.tabs.Tab> {
    return this.service.assertTabAccess(tabId, await this.session());
  }

  async createTab(url: string): Promise<chrome.tabs.Tab> {
    return this.service.createTab(await this.session(), url);
  }

  async listTabs(): Promise<chrome.tabs.Tab[]> {
    return this.service.listTabs(await this.session());
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.sessionId;
    if (pending) await this.service.closeSession(await pending);
  }
}
