import { Button, Card, Select, Space, Typography } from "@arco-design/web-react";
import { useCallback, useEffect, useState } from "react";
import type { AgentSessionView, TabAccessView, TabGrant } from "@App/pkg/browser-control/agent-window";
import { presentIndicator } from "@App/pkg/browser-control/tab-indicator";
import {
  AGENT_TAB_ACCESS_MESSAGE,
  type TabAccessAction,
  type TabAccessResponse,
} from "@App/pkg/browser-control/tab-access-message";
import { getCurrentTab } from "@App/pkg/utils/utils";

function requestTabAccess(body: TabAccessAction): Promise<TabAccessView> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: AGENT_TAB_ACCESS_MESSAGE, ...body }, (response: TabAccessResponse) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) return reject(new Error(lastError.message));
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.data);
    });
  });
}

function sessionName(session: AgentSessionView): string {
  return presentIndicator({ kind: "owned", ...session }).label;
}

function grantValue(grant: TabGrant | undefined): string {
  if (!grant) return "default";
  return grant.mode === "session" ? `session:${grant.sessionId}` : grant.mode;
}

function grantFromValue(value: string): TabGrant | undefined {
  if (value === "off" || value === "all") return { mode: value };
  if (value.startsWith("session:")) return { mode: "session", sessionId: value.slice("session:".length) };
  return undefined;
}

function AgentAccessCard() {
  const [view, setView] = useState<TabAccessView>();
  const [error, setError] = useState("");

  const run = useCallback((body: TabAccessAction) => {
    requestTabAccess(body).then(
      (data) => {
        setView(data);
        setError("");
      },
      (err: Error) => setError(err.message)
    );
  }, []);

  useEffect(() => {
    void getCurrentTab().then((tab) => {
      if (tab?.id !== undefined) run({ action: "get", tabId: tab.id });
    });
  }, [run]);

  if (!view) return null;
  const { tabId, owner } = view;
  const ownerStyle = owner ? presentIndicator({ kind: "owned", ...owner }) : undefined;

  return (
    <Card
      size="small"
      title="Agent access"
      style={{ marginBottom: 8 }}
      bodyStyle={{ display: "flex", flexDirection: "column", gap: 6 }}
    >
      {owner && ownerStyle ? (
        <Space size="mini" wrap>
          <span
            style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: ownerStyle.color }}
          />
          <Typography.Text style={{ fontSize: 12 }}>
            {`${ownerStyle.label}${owner.paused ? " (paused)" : ""}`}
          </Typography.Text>
          <Button
            size="mini"
            onClick={() => run({ action: owner.paused ? "resume" : "pause", tabId, sessionId: owner.sessionId })}
          >
            {owner.paused ? "Resume" : "Pause"}
          </Button>
          <Button size="mini" onClick={() => run({ action: "release", tabId })}>
            {"Release tab"}
          </Button>
          <Button size="mini" status="danger" onClick={() => run({ action: "end", tabId, sessionId: owner.sessionId })}>
            {"End session"}
          </Button>
        </Space>
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {"No agent is using this tab"}
        </Typography.Text>
      )}
      <Select
        size="mini"
        value={grantValue(view.grant)}
        onChange={(value: string) => run({ action: "grant", tabId, grant: grantFromValue(value) })}
      >
        <Select.Option value="default">
          {view.inAgentWindow ? "Default: agent window tab" : "Default: no agent access"}
        </Select.Option>
        <Select.Option value="off">{"Off: block all agents"}</Select.Option>
        <Select.Option value="all">{"Allow all agents"}</Select.Option>
        {view.sessions.map((session) => (
          <Select.Option key={session.sessionId} value={`session:${session.sessionId}`}>
            {`Only ${sessionName(session)}`}
          </Select.Option>
        ))}
      </Select>
      {error && (
        <Typography.Text type="error" style={{ fontSize: 12 }}>
          {error}
        </Typography.Text>
      )}
    </Card>
  );
}

export default AgentAccessCard;
