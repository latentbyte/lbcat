import { Button, Card, Input, Space, Tag, Typography } from "@arco-design/web-react";
import { useCallback, useEffect, useState } from "react";
import type { AgentNote, AgentNoteKind } from "@App/pkg/browser-control/agent-notes";
import { presentIndicator } from "@App/pkg/browser-control/tab-indicator";
import { AGENT_NOTES_MESSAGE, type NotesAction, type NotesResponse } from "@App/pkg/browser-control/tab-access-message";
import { getCurrentTab } from "@App/pkg/utils/utils";

const KIND_COLORS: Record<AgentNoteKind, string> = { "needs-human": "orange", info: "arcoblue", done: "green" };
const STATUS_ORDER = { open: 0, acknowledged: 1, resolved: 2 };

function requestNotes(body: NotesAction): Promise<AgentNote[]> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: AGENT_NOTES_MESSAGE, ...body }, (response: NotesResponse) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) return reject(new Error(lastError.message));
      if (!response.ok) return reject(new Error(response.error));
      resolve(response.data);
    });
  });
}

function NoteItem({ note, run }: { note: AgentNote; run: (body: NotesAction) => void }) {
  const [reply, setReply] = useState("");
  const author = presentIndicator({
    kind: "owned",
    sessionId: note.sessionId,
    label: note.label,
    paused: false,
    expiresAt: 0,
  });
  const { id, url } = note;
  const sendReply = () => {
    if (!reply.trim()) return;
    run({ action: "reply", url, id, text: reply });
    setReply("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, opacity: note.status === "resolved" ? 0.6 : 1 }}>
      <Space size="mini" wrap>
        <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: author.color }} />
        <Typography.Text style={{ fontSize: 12 }}>{author.label}</Typography.Text>
        <Tag size="small" color={KIND_COLORS[note.kind]}>
          {note.kind}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {`${note.status}, ${new Date(note.createdAt).toLocaleString()}`}
        </Typography.Text>
      </Space>
      <Typography.Text style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>{note.text}</Typography.Text>
      {note.reply && (
        <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: "pre-wrap" }}>
          {`You: ${note.reply}`}
        </Typography.Text>
      )}
      {note.status !== "resolved" && (
        <Input
          size="mini"
          placeholder="Reply to the agent"
          value={reply}
          onChange={setReply}
          onPressEnter={sendReply}
          maxLength={2000}
        />
      )}
      <Space size="mini" wrap>
        {note.status !== "resolved" && (
          <Button size="mini" disabled={!reply.trim()} onClick={sendReply}>
            {"Reply"}
          </Button>
        )}
        {note.status === "open" && (
          <Button size="mini" onClick={() => run({ action: "acknowledge", url, id })}>
            {"Acknowledge"}
          </Button>
        )}
        {note.status !== "resolved" && (
          <Button size="mini" onClick={() => run({ action: "resolve", url, id })}>
            {"Resolve"}
          </Button>
        )}
        <Button size="mini" status="danger" onClick={() => run({ action: "remove", url, id })}>
          {"Delete"}
        </Button>
      </Space>
    </div>
  );
}

function AgentNotesCard() {
  const [notes, setNotes] = useState<AgentNote[]>([]);
  const [error, setError] = useState("");

  const run = useCallback((body: NotesAction) => {
    requestNotes(body).then(
      (data) => {
        setNotes(data);
        setError("");
      },
      (err: Error) => setError(err.message)
    );
  }, []);

  useEffect(() => {
    void getCurrentTab().then((tab) => {
      if (tab?.url) run({ action: "list", url: tab.url });
    });
  }, [run]);

  if (!notes.length && !error) return null;
  const sorted = [...notes].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.createdAt - a.createdAt
  );

  return (
    <Card
      size="small"
      title="Agent notes"
      style={{ marginBottom: 8 }}
      bodyStyle={{ display: "flex", flexDirection: "column", gap: 10 }}
    >
      {sorted.map((note) => (
        <NoteItem key={note.id} note={note} run={run} />
      ))}
      {error && (
        <Typography.Text type="error" style={{ fontSize: 12 }}>
          {error}
        </Typography.Text>
      )}
    </Card>
  );
}

export default AgentNotesCard;
