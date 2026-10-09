package cli

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

func TestExtensionCommandFailure(t *testing.T) {
	for _, command := range []string{"tabs.create", "tabs.get", "tabs.focus", "page.reload"} {
		t.Run("浏览器拒绝"+command+"时返回错误", func(t *testing.T) {
			local, remote := net.Pipe()
			defer local.Close()
			defer remote.Close()
			client := &Client{conn: local}
			go func() {
				preflight, err := protocol.ReadEnvelope(remote)
				if err != nil {
					return
				}
				_ = protocol.WriteEnvelope(remote, &protocol.Envelope{ID: preflight.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"cmd":"agentWindow.status","data":{"windowId":17,"markerTabId":18}}`)})
				req, err := protocol.ReadEnvelope(remote)
				if err != nil {
					return
				}
				_ = protocol.WriteEnvelope(remote, &protocol.Envelope{ID: req.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"cmd":"error","error":{"code":"DENIED","message":"denied"}}`)})
			}()
			_, err := client.Request("zen-01", ExtCommand{Cmd: command})
			if err == nil {
				t.Fatal("browser failure reported as success")
			}
		})
	}
}

func TestScopedCommand(t *testing.T) {
	t.Run("仅浏览器页面命令携带会话与明确的个人标签授权", func(t *testing.T) {
		client := &Client{SessionID: "task-123", PersonalTabID: 42}
		original := map[string]any{"tabId": 42}
		got, err := client.scopedCommand(ExtCommand{Cmd: "page.exec", Args: original})
		if err != nil {
			t.Fatal(err)
		}
		args := got.Args.(map[string]any)
		if args["sessionId"] != "task-123" || args["personalTabId"] != 42 {
			t.Fatalf("args = %#v", args)
		}
		if _, ok := original["sessionId"]; ok {
			t.Fatal("mutated caller args")
		}
		note, err := client.scopedCommand(ExtCommand{Cmd: "notes.add", Args: map[string]any{"tabId": 42}})
		if err != nil || note.Args.(map[string]any)["sessionId"] != "task-123" {
			t.Fatalf("note args = %#v, error = %v", note.Args, err)
		}
		administrative, err := client.scopedCommand(ExtCommand{Cmd: "agentWindow.status"})
		if err != nil {
			t.Fatal(err)
		}
		if administrative.Args != nil {
			t.Fatalf("administrative args = %#v", administrative.Args)
		}
	})
}

func TestScopedCommandPreservesTypedArgs(t *testing.T) {
	t.Run("结构化参数不会被会话注入丢弃", func(t *testing.T) {
		client := &Client{SessionID: "task-123"}
		got, err := client.scopedCommand(ExtCommand{Cmd: "tabs.get", Args: struct {
			TabID int `json:"tabId"`
		}{42}})
		if err != nil {
			t.Fatal(err)
		}
		args := got.Args.(map[string]any)
		if args["tabId"] != float64(42) || args["sessionId"] != "task-123" {
			t.Fatalf("args = %#v", args)
		}
	})
	t.Run("无效参数类型返回明确错误", func(t *testing.T) {
		client := &Client{SessionID: "task-123"}
		if _, err := client.scopedCommand(ExtCommand{Cmd: "tabs.get", Args: 42}); err == nil {
			t.Fatal("invalid command args accepted")
		}
	})
}

func TestOlderExtensionFailsClosed(t *testing.T) {
	t.Run("旧扩展不认识窗口隔离命令时绝不发送原页面操作", func(t *testing.T) {
		local, remote := net.Pipe()
		defer local.Close()
		defer remote.Close()
		client := &Client{conn: local, SessionID: "task-123"}
		received := make(chan string, 1)
		go func() {
			request, err := protocol.ReadEnvelope(remote)
			if err != nil {
				return
			}
			var command ExtCommand
			_ = json.Unmarshal(request.Payload, &command)
			received <- command.Cmd
			_ = protocol.WriteEnvelope(remote, &protocol.Envelope{ID: request.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"cmd":"error","error":{"code":"UNKNOWN_COMMAND","message":"upgrade extension"}}`)})
		}()
		_, err := client.Request("zen-01", ExtCommand{Cmd: "page.exec", Args: map[string]any{"tabId": 42, "code": "location.href"}})
		if err == nil {
			t.Fatal("old extension accepted scoped command")
		}
		if got := <-received; got != "agentWindow.status" {
			t.Fatalf("first command = %s; original page operation escaped", got)
		}
	})
}

type deadlineRecordingConn struct {
	net.Conn
	deadlines []time.Time
}

func (c *deadlineRecordingConn) SetDeadline(deadline time.Time) error {
	if !deadline.IsZero() {
		c.deadlines = append(c.deadlines, deadline)
	}
	return c.Conn.SetDeadline(deadline)
}

func TestPreflightSharesRequestDeadline(t *testing.T) {
	t.Run("窗口安全检查与页面命令共用一个超时预算", func(t *testing.T) {
		local, remote := net.Pipe()
		defer local.Close()
		defer remote.Close()
		conn := &deadlineRecordingConn{Conn: local}
		client := &Client{conn: conn}
		go func() {
			for _, payload := range []json.RawMessage{json.RawMessage(`{"data":{"windowId":7,"markerTabId":8}}`), json.RawMessage(`{"data":{"id":42}}`)} {
				request, err := protocol.ReadEnvelope(remote)
				if err != nil {
					return
				}
				_ = protocol.WriteEnvelope(remote, &protocol.Envelope{ID: request.ID, Type: protocol.MsgResponse, Payload: payload})
			}
		}()
		if _, err := client.RequestWithTimeout("zen-01", ExtCommand{Cmd: "tabs.get", Args: map[string]any{"tabId": 42}}, time.Second); err != nil {
			t.Fatal(err)
		}
		if len(conn.deadlines) != 2 || !conn.deadlines[0].Equal(conn.deadlines[1]) {
			t.Fatalf("deadlines = %v", conn.deadlines)
		}
	})
}

func TestInvalidWindowStatusFailsClosed(t *testing.T) {
	t.Run("窗口状态缺少隔离标记时拒绝页面操作", func(t *testing.T) {
		local, remote := net.Pipe()
		defer local.Close()
		defer remote.Close()
		client := &Client{conn: local}
		go func() {
			request, err := protocol.ReadEnvelope(remote)
			if err != nil {
				return
			}
			_ = protocol.WriteEnvelope(remote, &protocol.Envelope{ID: request.ID, Type: protocol.MsgResponse, Payload: json.RawMessage(`{"data":{"windowId":7}}`)})
		}()
		if _, err := client.Request("zen-01", ExtCommand{Cmd: "tabs.get", Args: map[string]any{"tabId": 42}}); err == nil {
			t.Fatal("invalid registration allowed page command")
		}
	})
}
