package daemon

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"

	"github.com/google/uuid"
	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
)

// Router dispatches messages between connections based on envelope metadata.
// It tracks pending requests so responses can be routed back to the originator.
type Router struct {
	reg     *Registry
	pending sync.Map // msg_id -> pendingRequest
}

// NewRouter creates a router backed by the given registry.
func NewRouter(reg *Registry) *Router {
	return &Router{reg: reg}
}

type pendingRequest struct {
	originID string
	targetID string
}

// Route handles a single envelope from the given source connection.
func (rt *Router) Route(src *Conn, env *protocol.Envelope) error {
	switch env.Type {
	case protocol.MsgRequest:
		return rt.routeRequest(src, env)
	case protocol.MsgResponse:
		return rt.routeResponse(env)
	case protocol.MsgEvent:
		return rt.routeEvent(src, env)
	default:
		return fmt.Errorf("unknown message type: %s", env.Type)
	}
}

// routeRequest forwards a request from CLI to the target browser(s).
// If target is "daemon", the daemon handles it directly without forwarding.
func (rt *Router) routeRequest(src *Conn, env *protocol.Envelope) error {
	if env.Target == "daemon" {
		return rt.handleDaemonCommand(src, env)
	}

	if env.Target == "*" {
		return rt.sendError(src, env.ID, "UNSUPPORTED_TARGET",
			`target "*" is not supported for request/response commands`)
	}

	dst, ok := rt.reg.Get(env.Target)
	if !ok {
		return rt.sendError(src, env.ID, "CONN_NOT_FOUND",
			fmt.Sprintf("target %q not connected", env.Target))
	}

	// remember where to send the response
	rt.pending.Store(env.ID, pendingRequest{
		originID: src.ID,
		targetID: env.Target,
	})

	if err := dst.WriteEnvelope(env); err != nil {
		rt.pending.Delete(env.ID)
		return rt.sendError(src, env.ID, "FORWARD_FAILED",
			fmt.Sprintf("failed to forward request to %q: %v", env.Target, err))
	}
	return nil
}

// handleDaemonCommand processes commands targeted at the daemon itself.
func (rt *Router) handleDaemonCommand(src *Conn, env *protocol.Envelope) error {
	var cmd struct {
		Cmd string `json:"cmd"`
	}
	if err := json.Unmarshal(env.Payload, &cmd); err != nil {
		return rt.sendError(src, env.ID, "INVALID_PAYLOAD", "cannot parse command")
	}

	var respData any

	switch cmd.Cmd {
	case "ping":
		respData = map[string]any{
			"cmd":  "pong",
			"data": map[string]any{"pid": os.Getpid()},
		}
	case "status":
		respData = map[string]any{
			"cmd": "status",
			"data": map[string]any{
				"pid":         os.Getpid(),
				"socket":      protocol.SocketPath(),
				"connections": rt.reg.Info(),
				"history":     rt.reg.History(),
			},
		}
	default:
		return rt.sendError(src, env.ID, "UNKNOWN_COMMAND",
			fmt.Sprintf("daemon does not handle %q", cmd.Cmd))
	}

	payload, _ := json.Marshal(respData)
	resp := &protocol.Envelope{
		ID:      env.ID,
		Type:    protocol.MsgResponse,
		Payload: payload,
	}
	return src.WriteEnvelope(resp)
}

// routeResponse forwards a response from browser back to the originating CLI.
func (rt *Router) routeResponse(env *protocol.Envelope) error {
	raw, ok := rt.pending.LoadAndDelete(env.ID)
	if !ok {
		log.Printf("router: no pending request for response id=%s", env.ID)
		return nil
	}

	req, ok := raw.(pendingRequest)
	if !ok {
		log.Printf("router: malformed pending entry for response id=%s", env.ID)
		return nil
	}
	env.Source = req.targetID

	originID := req.originID
	dst, ok := rt.reg.Get(originID)
	if !ok {
		log.Printf("router: origin %s disconnected before response", originID)
		return nil
	}

	return dst.WriteEnvelope(env)
}

// routeEvent forwards an event from browser to all connected CLIs.
func (rt *Router) routeEvent(src *Conn, env *protocol.Envelope) error {
	env.Source = src.ID
	return rt.broadcast(env, protocol.RoleCLI)
}

// BroadcastBrowserLifecycle sends public browser connection lifecycle events to CLIs.
func (rt *Router) BroadcastBrowserLifecycle(conn *Conn, typ string) error {
	if conn == nil || conn.Role != protocol.RoleBrowser {
		return nil
	}
	payload, err := json.Marshal(map[string]any{
		"cmd": "browser.event",
		"data": map[string]any{
			"type":        typ,
			"browserId":   conn.ID,
			"browserName": conn.Meta.Browser,
			"appName":     appNameForBrowser(conn.Meta.Browser),
		},
	})
	if err != nil {
		return fmt.Errorf("encoding browser lifecycle event: %w", err)
	}
	return rt.broadcast(&protocol.Envelope{
		ID:      "evt-" + uuid.NewString(),
		Type:    protocol.MsgEvent,
		Source:  "daemon",
		Payload: payload,
	}, protocol.RoleCLI)
}

// broadcast sends an envelope to all connections of the given role.
func (rt *Router) broadcast(env *protocol.Envelope, role protocol.ConnRole) error {
	var targets []*Conn
	if role == protocol.RoleBrowser {
		targets = rt.reg.Browsers()
	} else {
		targets = rt.reg.CLIs()
	}

	var firstErr error
	for _, dst := range targets {
		if err := dst.WriteEnvelope(env); err != nil {
			log.Printf("router: broadcast to %s failed: %v", dst.ID, err)
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// sendError sends an error response back to a connection.
func (rt *Router) sendError(dst *Conn, msgID, code, message string) error {
	errPayload, _ := json.Marshal(map[string]any{
		"cmd": "error",
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
	resp := &protocol.Envelope{
		ID:      msgID,
		Type:    protocol.MsgResponse,
		Payload: errPayload,
	}
	return dst.WriteEnvelope(resp)
}

// ClearPending removes pending requests related to a disconnected connection.
// For origin disconnects, requests are dropped.
// For target disconnects, an error is sent back to the originating CLI.
func (rt *Router) ClearPending(connID string) {
	rt.pending.Range(func(key, val any) bool {
		msgID, ok := key.(string)
		if !ok {
			return true
		}
		req, ok := val.(pendingRequest)
		if !ok {
			rt.pending.Delete(msgID)
			return true
		}
		if req.originID == connID {
			rt.pending.Delete(msgID)
		} else if req.targetID == connID {
			rt.pending.Delete(msgID)
			if dst, ok := rt.reg.Get(req.originID); ok {
				_ = rt.sendError(dst, msgID, "TARGET_DISCONNECTED",
					fmt.Sprintf("target %q disconnected before response", connID))
			}
		}
		return true
	})
}

func appNameForBrowser(browser string) string {
	switch strings.ToLower(browser) {
	case "chrome":
		return "Google Chrome"
	case "chromium":
		return "Chromium"
	case "comet":
		return "Comet"
	case "firefox":
		return "Firefox"
	case "brave":
		return "Brave Browser"
	case "edge":
		return "Microsoft Edge"
	case "opera":
		return "Opera"
	case "vivaldi":
		return "Vivaldi"
	case "zen":
		return "Zen"
	case "waterfox":
		return "Waterfox"
	case "librewolf":
		return "LibreWolf"
	case "floorp":
		return "Floorp"
	default:
		return browser
	}
}
