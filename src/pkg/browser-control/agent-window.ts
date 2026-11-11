import { BrowserControlError } from "./errors";

const STATE_KEY = "browserControl.agentWindow";
// 标签 ID 仅在本次浏览器运行内有效，授权放在会话存储中随浏览器重启清除
const GRANTS_KEY = "browserControl.tabGrants";
// 本次浏览器运行内已确认的标记，重启后才允许按 URL 恢复登记
const VERIFIED_KEY = "browserControl.verifiedMarkerUrl";
const DEFAULT_TTL = 15 * 60 * 1000;
const MAX_TTL = 24 * 60 * 60 * 1000;
const MAX_LABEL = 60;

export type AgentWindowStatus = { windowId: number; markerTabId: number };
type Registration = AgentWindowStatus & { markerUrl: string; eligibleTabIds?: number[] };
type Session = {
  sessionId: string;
  label?: string;
  expiresAt: number;
  ttlMs: number;
  paused: boolean;
  tabIds: number[];
};
// 用户在标签上设置的代理访问：关闭、允许所有任务或仅允许指定任务
export type TabGrant = { mode: "off" } | { mode: "all" } | { mode: "session"; sessionId: string };
type State = {
  registration?: Registration;
  sessions: Session[];
  tabGrants?: Record<number, TabGrant>;
  verifiedMarkerUrl?: string;
};

export type AgentSessionView = { sessionId: string; label?: string; expiresAt: number; paused: boolean };
// 只暴露来源（scheme://host[:port]），其他任务的路径、标题等不可见
export type AgentSessionTab = { id: number; origin: string | null };
export type TabAccessView = {
  tabId: number;
  grant?: TabGrant;
  inAgentWindow: boolean;
  owner?: AgentSessionView;
  sessions: AgentSessionView[];
};
export type TabIndicator =
  | { kind: "owned"; sessionId: string; label?: string; paused: boolean; expiresAt: number }
  | { kind: "off" };
// 人工切换器看到的代理管理状态：标记、专用窗口工作标签或获授权的个人标签
export type AgentTabView = { role: "marker" | "work" | "granted"; label?: string; paused?: boolean };
export type TabIndicatorListener = (indicators: Map<number, TabIndicator>) => void;

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
  allTabs(): Promise<chrome.tabs.Tab[]>;
  createTab(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  removeTab(tabId: number): Promise<void>;
  getWindow(windowId: number): Promise<chrome.windows.Window>;
  listWindows(): Promise<chrome.windows.Window[]>;
  createWindow(properties: chrome.windows.CreateData): Promise<chrome.windows.Window | undefined>;
}

export class BrowserControlScopeError extends BrowserControlError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "BrowserControlScopeError";
  }
}

// 说明登记失效的原因，便于区分从未创建与扩展重载、重启后丢失
function missingWindow(reason: string): BrowserControlScopeError {
  return new BrowserControlScopeError(
    "AGENT_WINDOW_MISSING",
    `${reason}; open or designate the agent window (agent-window create) before continuing`
  );
}

function sessionLabel(label: string | undefined): string | undefined {
  const value = label?.replace(/\s+/g, " ").trim().slice(0, MAX_LABEL);
  return value || undefined;
}

function sessionView({ sessionId, label, expiresAt, paused }: Session): AgentSessionView {
  return { sessionId, label, expiresAt, paused };
}

function httpOrigin(tab: chrome.tabs.Tab | undefined): string | null {
  const url = URL.parse(tab?.url || tab?.pendingUrl || "");
  return url?.protocol === "http:" || url?.protocol === "https:" ? url.origin : null;
}

export class AgentWindowService implements AgentWindowScope {
  private pending: Promise<void> = Promise.resolve();
  private listeners = new Set<TabIndicatorListener>();

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
      if (this.listeners.size) {
        const indicators = this.indicators(state);
        for (const listener of this.listeners) listener(indicators);
      }
      return result;
    } finally {
      release();
    }
  }

  private async registration(state: State): Promise<Registration> {
    const registration = state.registration;
    if (!registration) throw missingWindow("No agent window is registered");
    const marker = await this.deps.getTab(registration.markerTabId).catch(() => undefined);
    if (marker?.url !== registration.markerUrl) return this.recoverRegistration(state, registration);
    if (marker.windowId !== registration.windowId)
      throw missingWindow("The agent window marker tab moved to another window");
    state.verifiedMarkerUrl = registration.markerUrl;
    return registration;
  }

  // 浏览器重启后标签 ID 失效，仅在唯一匹配登记标记时重新绑定，旧 ID 授权全部作废
  private async recoverRegistration(state: State, registration: Registration): Promise<Registration> {
    // 本次运行中已确认过的标记消失表示被关闭，不得改绑到残留副本
    if (state.verifiedMarkerUrl === registration.markerUrl)
      throw missingWindow("The agent window marker tab was closed");
    const markers = (await this.deps.allTabs()).filter((tab) => tab.url === registration.markerUrl);
    const marker = markers[0];
    if (!markers.length)
      throw missingWindow("The agent window marker tab is gone (extension reload/update or browser restart)");
    if (markers.length !== 1 || marker.id === undefined)
      throw missingWindow(`Found ${markers.length} copies of the agent window marker`);
    const recovered: Registration = {
      windowId: marker.windowId,
      markerTabId: marker.id,
      markerUrl: registration.markerUrl,
      eligibleTabIds: [],
    };
    state.registration = recovered;
    state.verifiedMarkerUrl = registration.markerUrl;
    for (const session of state.sessions) session.tabIds = [];
    return recovered;
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

  private isMarker(tab: chrome.tabs.Tab): boolean {
    const markerUrl = this.deps.markerUrl();
    return [tab.url, tab.pendingUrl].some((url) => url?.split(/[?#]/, 1)[0] === markerUrl);
  }

  private async readyMarker(tabId: number, windowId: number, markerUrl: string): Promise<void> {
    for (let attempt = 0; attempt < 80; attempt++) {
      const tab = await this.deps.getTab(tabId);
      if (tab.windowId !== windowId) throw missingWindow("The new agent window marker tab left its window");
      if (tab.url === markerUrl) return;
      if (tab.pendingUrl !== markerUrl && tab.url && tab.url !== "about:blank")
        throw missingWindow("The new agent window marker tab navigated away");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw missingWindow("The new agent window marker tab did not load");
  }

  async create(): Promise<AgentWindowStatus> {
    return this.withState(async (state) => {
      const markerUrl = this.deps.markerUrl() + "?registration=" + this.deps.id();
      const window = await this.deps.createWindow({ url: markerUrl, focused: false, type: "normal" });
      if (window?.id === undefined) throw new Error("Could not create agent window marker");
      if (window.incognito || window.type !== "normal") {
        throw new BrowserControlScopeError(
          "INVALID_AGENT_WINDOW",
          "Agent window must be a normal, non-incognito window"
        );
      }
      const matchesMarker = (tab: chrome.tabs.Tab): boolean => tab.url === markerUrl || tab.pendingUrl === markerUrl;
      let marker = window.tabs?.find(matchesMarker);
      for (let attempt = 0; marker?.id === undefined && attempt < 80; attempt++) {
        marker = (await this.deps.listTabs(window.id)).find(matchesMarker);
        if (marker?.id === undefined) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (marker?.id === undefined) throw new Error("Could not identify agent window marker");
      await this.readyMarker(marker.id, window.id, markerUrl);
      const registration: Registration = {
        windowId: window.id,
        markerTabId: marker.id,
        markerUrl,
        eligibleTabIds: [],
      };
      await this.registration({ registration, sessions: [] });
      state.registration = registration;
      state.verifiedMarkerUrl = markerUrl;
      state.sessions = [];
      return { windowId: window.id, markerTabId: marker.id };
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
      const eligibleTabIds = (await this.deps.listTabs(windowId))
        .filter((tab) => tab.id !== undefined && !this.isMarker(tab))
        .map((tab) => tab.id!);
      const markerUrl = this.deps.markerUrl() + "?registration=" + this.deps.id();
      // 不固定标记：Zen 会把固定标签复制到每个新窗口
      const marker = await this.deps.createTab({ windowId, url: markerUrl, active: false });
      if (marker.id === undefined) throw new Error("Could not create agent window marker");
      await this.readyMarker(marker.id, windowId, markerUrl);
      const registration: Registration = { windowId, markerTabId: marker.id, markerUrl, eligibleTabIds };
      await this.registration({ registration, sessions: [] });
      state.registration = registration;
      state.verifiedMarkerUrl = markerUrl;
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

  async openSession(ttlMs = DEFAULT_TTL, label?: string): Promise<{ sessionId: string; expiresAt: number }> {
    if (!Number.isFinite(ttlMs) || ttlMs < 1000 || ttlMs > MAX_TTL)
      throw new Error("Session TTL must be between 1s and 24h");
    return this.withState(async (state) => {
      await this.registration(state);
      return this.startSession(state, ttlMs, sessionLabel(label));
    });
  }

  private startSession(state: State, ttlMs: number, label?: string): { sessionId: string; expiresAt: number } {
    // 保留过期暂停记录，避免其他任务清理租约后绕过人工接管
    state.sessions = state.sessions.filter((item) => item.paused || item.expiresAt > this.deps.now());
    // 短 ID 节省代理每次命令携带的 token；仅需在本浏览器的现存会话内唯一
    let sessionId: string;
    do sessionId = this.deps.id().slice(0, 8);
    while (state.sessions.some((item) => item.sessionId === sessionId));
    const session: Session = {
      sessionId,
      ...(label ? { label } : {}),
      expiresAt: this.deps.now() + ttlMs,
      ttlMs,
      paused: false,
      tabIds: [],
    };
    state.sessions.push(session);
    return { sessionId: session.sessionId, expiresAt: session.expiresAt };
  }

  async recoverSession(sessionId: string): Promise<{ sessionId: string; expiresAt: number }> {
    return this.withState(async (state) => {
      await this.registration(state);
      const previous = state.sessions.find((item) => item.sessionId === sessionId);
      if (previous?.paused) throw new BrowserControlScopeError("SESSION_PAUSED", "Browser task is paused");
      if (previous && previous.expiresAt > this.deps.now()) {
        return { sessionId: previous.sessionId, expiresAt: previous.expiresAt };
      }
      return this.startSession(state, DEFAULT_TTL, previous?.label);
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

  // 可选关闭任务拥有的代理窗口工作标签；个人标签与暂停（人工接管）时的标签保留
  async closeSession(
    sessionId: string,
    options: { closeTabs?: boolean } = {}
  ): Promise<{ closedTabIds: number[]; keptTabIds: number[] }> {
    return this.withState(async (state) => {
      const session = state.sessions.find((item) => item.sessionId === sessionId);
      const closedTabIds: number[] = [];
      const keptTabIds: number[] = [];
      const registration = state.registration;
      for (const tabId of options.closeTabs ? (session?.tabIds ?? []) : []) {
        const tab = await this.deps.getTab(tabId).catch(() => undefined);
        if (!tab) continue;
        const workTab =
          registration &&
          tab.windowId === registration.windowId &&
          tabId !== registration.markerTabId &&
          registration.eligibleTabIds?.includes(tabId);
        if (!workTab || session!.paused) {
          keptTabIds.push(tabId);
          continue;
        }
        await this.deps.removeTab(tabId);
        registration.eligibleTabIds = registration.eligibleTabIds!.filter((id) => id !== tabId);
        closedTabIds.push(tabId);
      }
      state.sessions = state.sessions.filter((item) => item.sessionId !== sessionId);
      return { closedTabIds, keptTabIds };
    });
  }

  async listSessions(): Promise<Array<AgentSessionView & { tabIds: number[]; tabs: AgentSessionTab[] }>> {
    return this.withState(async (state) => {
      await this.registration(state);
      const live = state.sessions.filter((session) => session.expiresAt > this.deps.now());
      return Promise.all(
        live.map(async (session) => ({
          ...sessionView(session),
          tabIds: [...session.tabIds],
          tabs: await Promise.all(
            session.tabIds.map(async (id) => ({
              id,
              origin: httpOrigin(await this.deps.getTab(id).catch(() => undefined)),
            }))
          ),
        }))
      );
    });
  }

  private owner(state: State, tabId: number): Session | undefined {
    return state.sessions.find((item) => item.expiresAt > this.deps.now() && item.tabIds.includes(tabId));
  }

  // 指定任务的授权仅在该任务仍存在（含暂停）时生效
  private grant(state: State, tabId: number): TabGrant | undefined {
    const grant = state.tabGrants?.[tabId];
    if (grant?.mode !== "session") return grant;
    const live = state.sessions.some(
      (item) => item.sessionId === grant.sessionId && (item.paused || item.expiresAt > this.deps.now())
    );
    return live ? grant : undefined;
  }

  // 按用户授权判断任务能否使用标签；undefined 表示沿用专用窗口规则
  private grantAllows(grant: TabGrant | undefined, sessionId?: string): boolean | undefined {
    if (!grant) return undefined;
    if (grant.mode === "off") return false;
    return grant.mode === "all" || grant.sessionId === sessionId;
  }

  private release(state: State, tabId: number, keepSessionId?: string): void {
    for (const session of state.sessions) {
      if (session.sessionId !== keepSessionId) session.tabIds = session.tabIds.filter((id) => id !== tabId);
    }
  }

  private async windowTab(
    state: State,
    tabId: number,
    personalTabId?: number,
    sessionId?: string
  ): Promise<chrome.tabs.Tab> {
    const registration = await this.registration(state);
    if (tabId === registration.markerTabId) {
      throw new BrowserControlScopeError("AGENT_MARKER_PROTECTED", "Agent window marker is not a work tab");
    }
    const tab = await this.deps.getTab(tabId);
    if (this.isMarker(tab)) {
      throw new BrowserControlScopeError("AGENT_MARKER_PROTECTED", "Agent window marker is not a work tab");
    }
    const granted = this.grantAllows(this.grant(state, tabId), sessionId);
    if (granted === false) {
      throw new BrowserControlScopeError("TAB_ACCESS_DENIED", "Agent access to this tab is turned off for this task");
    }
    if (
      (tab.windowId !== registration.windowId || !registration.eligibleTabIds?.includes(tabId)) &&
      personalTabId !== tabId &&
      !granted
    ) {
      throw new BrowserControlScopeError(
        "PERSONAL_TAB_DENIED",
        "Tab lacks an agent-window grant; explicit per-tab permission required"
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
      const tab = await this.windowTab(state, tabId, personalTabId, sessionId);
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
      registration.eligibleTabIds ??= [];
      registration.eligibleTabIds.push(tab.id);
      session.tabIds.push(tab.id);
      session.expiresAt = this.deps.now() + session.ttlMs;
      return tab;
    });
  }

  // 代理只能关闭专用窗口中的工作标签；个人标签即使授权使用也不允许关闭
  async closeTab(tabId: number, sessionId: string | undefined): Promise<chrome.tabs.Tab> {
    return this.withState(async (state) => {
      const registration = await this.registration(state);
      this.session(state, sessionId);
      const tab = await this.windowTab(state, tabId, undefined, sessionId);
      if (tab.windowId !== registration.windowId || !registration.eligibleTabIds?.includes(tabId))
        throw new BrowserControlScopeError("PERSONAL_TAB_DENIED", "Agents can only close agent-window work tabs");
      const owner = this.owner(state, tabId);
      if (owner && owner.sessionId !== sessionId)
        throw new BrowserControlScopeError("TAB_BUSY", "Tab belongs to another browser task");
      await this.deps.removeTab(tabId);
      this.release(state, tabId);
      registration.eligibleTabIds = registration.eligibleTabIds.filter((id) => id !== tabId);
      return tab;
    });
  }

  // 人工关闭任意标签，仅保护代理窗口标记
  async closeAnyTab(tabId: number): Promise<chrome.tabs.Tab> {
    return this.withState(async (state) => {
      const tab = await this.deps.getTab(tabId);
      if (tabId === state.registration?.markerTabId || this.isMarker(tab))
        throw new BrowserControlScopeError("AGENT_MARKER_PROTECTED", "Agent window marker cannot be closed this way");
      await this.deps.removeTab(tabId);
      this.release(state, tabId);
      return tab;
    });
  }

  async allowsTabEvent(tabId: number, windowId: number, url?: string): Promise<boolean> {
    return this.withState(async (state) => {
      const registration = await this.registration(state);
      const grant = this.grant(state, tabId);
      if (grant) return grant.mode !== "off";
      return (
        registration.windowId === windowId &&
        registration.markerTabId !== tabId &&
        !!registration.eligibleTabIds?.includes(tabId) &&
        url?.split(/[?#]/, 1)[0] !== this.deps.markerUrl()
      );
    });
  }

  async listTabs(sessionId?: string): Promise<chrome.tabs.Tab[]> {
    return this.withState(async (state) => {
      const registration = await this.registration(state);
      if (sessionId) this.session(state, sessionId).expiresAt = this.deps.now() + this.session(state, sessionId).ttlMs;
      const tabs = await this.deps.listTabs(registration.windowId);
      const listed = new Set(tabs.map((tab) => tab.id));
      const grantedIds = Object.keys(state.tabGrants ?? {})
        .map(Number)
        .filter((tabId) => !listed.has(tabId) && this.grantAllows(this.grant(state, tabId), sessionId));
      // 已关闭的授权标签由 forgetTab 清理，这里只跳过尚未清理的记录
      const granted = await Promise.allSettled(grantedIds.map((tabId) => this.deps.getTab(tabId)));
      for (const result of granted) if (result.status === "fulfilled") tabs.push(result.value);
      return tabs.filter((tab) => {
        if (tab.id === undefined || tab.id === registration.markerTabId || this.isMarker(tab)) return false;
        const allowed = this.grantAllows(this.grant(state, tab.id), sessionId);
        if (allowed === false) return false;
        if (!allowed && (tab.windowId !== registration.windowId || !registration.eligibleTabIds?.includes(tab.id)))
          return false;
        const owner = this.owner(state, tab.id);
        return !owner || owner.sessionId === sessionId;
      });
    });
  }

  async setTabGrant(tabId: number, grant: TabGrant | undefined): Promise<void> {
    await this.withState(async (state) => {
      if (grant?.mode === "session") this.session(state, grant.sessionId, true);
      state.tabGrants ??= {};
      if (!grant) {
        delete state.tabGrants[tabId];
        return;
      }
      state.tabGrants[tabId] = grant;
      if (grant.mode === "off") this.release(state, tabId);
      if (grant.mode === "session") this.release(state, tabId, grant.sessionId);
    });
  }

  async tabAccess(tabId: number): Promise<TabAccessView> {
    return this.withState(async (state) => {
      const owner = this.owner(state, tabId);
      return {
        tabId,
        grant: this.grant(state, tabId),
        inAgentWindow: !!state.registration?.eligibleTabIds?.includes(tabId),
        ...(owner ? { owner: sessionView(owner) } : {}),
        sessions: state.sessions
          .filter((item) => item.paused || item.expiresAt > this.deps.now())
          .map((item) => sessionView(item)),
      };
    });
  }

  // 只读分类，不恢复登记；标签 ID 在本次浏览器运行内确认过标记后才可信
  async agentTabs(tabs: Array<Pick<chrome.tabs.Tab, "id" | "windowId">>): Promise<Map<number, AgentTabView>> {
    return this.withState(async (state) => {
      const views = new Map<number, AgentTabView>();
      const registration = state.registration?.markerUrl === state.verifiedMarkerUrl ? state.registration : undefined;
      for (const tab of tabs) {
        if (tab.id === undefined) continue;
        if (registration?.markerTabId === tab.id) {
          views.set(tab.id, { role: "marker" });
          continue;
        }
        const grant = this.grant(state, tab.id);
        const inWindow = registration?.windowId === tab.windowId && !!registration.eligibleTabIds?.includes(tab.id);
        if (grant?.mode === "off" || (!grant && !inWindow)) continue;
        const owner = this.owner(state, tab.id);
        views.set(tab.id, {
          role: inWindow ? "work" : "granted",
          ...(owner?.label ? { label: owner.label } : {}),
          ...(owner?.paused ? { paused: true } : {}),
        });
      }
      return views;
    });
  }

  async releaseTab(tabId: number): Promise<void> {
    await this.withState(async (state) => this.release(state, tabId));
  }

  async forgetTab(tabId: number): Promise<void> {
    await this.withState(async (state) => {
      this.release(state, tabId);
      if (state.tabGrants) delete state.tabGrants[tabId];
      if (state.registration?.eligibleTabIds)
        state.registration.eligibleTabIds = state.registration.eligibleTabIds.filter((id) => id !== tabId);
    });
  }

  // 订阅每个标签的代理标识，用于徽标与页面边框
  subscribe(listener: TabIndicatorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async currentIndicators(): Promise<Map<number, TabIndicator>> {
    return this.withState(async (state) => this.indicators(state));
  }

  private indicators(state: State): Map<number, TabIndicator> {
    const indicators = new Map<number, TabIndicator>();
    for (const [tabId, grant] of Object.entries(state.tabGrants ?? {})) {
      if (grant.mode === "off") indicators.set(Number(tabId), { kind: "off" });
    }
    for (const session of state.sessions) {
      if (session.expiresAt <= this.deps.now()) continue;
      const { sessionId, label, paused, expiresAt } = session;
      for (const tabId of session.tabIds) {
        if (!indicators.has(tabId)) indicators.set(tabId, { kind: "owned", sessionId, label, paused, expiresAt });
      }
    }
    return indicators;
  }
}

export const agentWindowService = new AgentWindowService({
  load: async () => {
    const [local, session] = await Promise.all([
      chrome.storage.local.get(STATE_KEY),
      chrome.storage.session.get([GRANTS_KEY, VERIFIED_KEY]),
    ]);
    const state = local[STATE_KEY] as State | undefined;
    const tabGrants = session[GRANTS_KEY] as State["tabGrants"];
    const verifiedMarkerUrl = session[VERIFIED_KEY] as string | undefined;
    return state || tabGrants ? { sessions: [], ...state, tabGrants, verifiedMarkerUrl } : undefined;
  },
  save: async ({ tabGrants, verifiedMarkerUrl, ...state }) => {
    await Promise.all([
      chrome.storage.local.set({ [STATE_KEY]: state }),
      chrome.storage.session.set({
        [GRANTS_KEY]: tabGrants ?? {},
        ...(verifiedMarkerUrl ? { [VERIFIED_KEY]: verifiedMarkerUrl } : {}),
      }),
    ]);
  },
  markerUrl: () => chrome.runtime.getURL("src/agent-window.html"),
  id: () => crypto.randomUUID(),
  now: () => Date.now(),
  getTab: (tabId) => chrome.tabs.get(tabId),
  listTabs: (windowId) => chrome.tabs.query({ windowId }),
  allTabs: () => chrome.tabs.query({}),
  createTab: (properties) => chrome.tabs.create(properties),
  removeTab: (tabId) => chrome.tabs.remove(tabId),
  getWindow: (windowId) => chrome.windows.get(windowId),
  listWindows: () => chrome.windows.getAll({ windowTypes: ["normal"] }),
  createWindow: (properties) => chrome.windows.create(properties),
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

  private async withSession<T>(action: (sessionId: string) => Promise<T>): Promise<T> {
    const pending = this.session();
    const sessionId = await pending;
    try {
      return await action(sessionId);
    } catch (error) {
      if (!(error instanceof BrowserControlScopeError) || error.code !== "SESSION_EXPIRED") throw error;
      if (this.closed) throw new BrowserControlScopeError("SESSION_CLOSED", "Browser task has ended");
      if (this.sessionId === pending) {
        const replacement = this.service
          .recoverSession(sessionId)
          .then(({ sessionId }) => sessionId)
          .catch((error: unknown) => {
            if (this.sessionId === replacement) this.sessionId = pending;
            throw error;
          });
        this.sessionId = replacement;
      }
      return action(await this.session());
    }
  }

  status(): Promise<AgentWindowStatus> {
    return this.service.status();
  }

  async assertWindowTab(tabId: number): Promise<chrome.tabs.Tab> {
    return this.withSession((sessionId) => this.service.assertTabAccess(tabId, sessionId));
  }

  async createTab(url: string): Promise<chrome.tabs.Tab> {
    return this.withSession((sessionId) => this.service.createTab(sessionId, url));
  }

  async listTabs(): Promise<chrome.tabs.Tab[]> {
    return this.withSession((sessionId) => this.service.listTabs(sessionId));
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = this.sessionId;
    if (pending) await this.service.closeSession(await pending);
  }
}
