package browsercontrol

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"slices"
	"sort"
	"strings"
	"sync"

	internalcli "github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
)

// Client is the stable public Browser Control API
type Client interface {
	ListTabs(ctx context.Context, opts ListTabsOptions) ([]model.Tab, error)
	FocusTab(ctx context.Context, req FocusTabRequest) (FocusTabResult, error)
	CloseTab(ctx context.Context, req CloseTabRequest) error
	Subscribe(ctx context.Context, opts SubscribeOptions) (<-chan model.Event, error)
	Status(ctx context.Context) (Status, error)
	Close() error
}

// New connects to the Browser Control daemon through the default Unix socket
func New(ctx context.Context) (Client, error) {
	client, err := newClient(ctx, false)
	if err != nil {
		return nil, err
	}
	return client, nil
}

// NewSwitcher 连接供人工标签切换器使用的窄接口，不授予页面内容访问权限
func NewSwitcher(ctx context.Context) (Client, error) {
	client, err := newClient(ctx, true)
	if err != nil {
		return nil, err
	}
	status, err := client.Status(ctx)
	if err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("verifying switcher event isolation: %w", err)
	}
	if !slices.Contains(status.Capabilities, "switcher-tabs") {
		_ = client.Close()
		return nil, errors.New("daemon does not support isolated switcher tab events; upgrade browser-control daemon")
	}
	return client, nil
}

func newClient(ctx context.Context, switcher bool) (*daemonClient, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	c, err := internalcli.Connect()
	if err != nil {
		return nil, err
	}
	return &daemonClient{cli: c, switcher: switcher}, nil
}

// ListTabsOptions controls tab listing
type ListTabsOptions struct {
	BrowserID           model.BrowserID `json:"browserId,omitempty"`
	AllBrowsers         bool            `json:"allBrowsers,omitempty"`
	SessionID           string          `json:"sessionId,omitempty"`
	PersonalTabID       int             `json:"personalTabId,omitempty"`
	NotifyMissingWindow bool            `json:"-"`
}

// FocusTabRequest identifies the tab to focus
type FocusTabRequest struct {
	BrowserID     model.BrowserID `json:"browserId"`
	TabID         int64           `json:"tabId"`
	WindowID      int             `json:"windowId,omitempty"`
	SessionID     string          `json:"sessionId,omitempty"`
	PersonalTabID int             `json:"personalTabId,omitempty"`
	AllowFocus    bool            `json:"allowFocus"`
}

// FocusTabResult reports the focused tab
type FocusTabResult struct {
	BrowserID model.BrowserID `json:"browserId"`
	TabID     int64           `json:"tabId"`
	WindowID  int             `json:"windowId,omitempty"`
}

// CloseTabRequest identifies the tab to close; an empty BrowserID selects the only connected browser
type CloseTabRequest struct {
	BrowserID model.BrowserID `json:"browserId,omitempty"`
	TabID     int64           `json:"tabId"`
	SessionID string          `json:"sessionId,omitempty"`
}

// SubscribeOptions controls event subscription
type SubscribeOptions struct {
	BrowserID           model.BrowserID   `json:"browserId,omitempty"`
	AllBrowsers         bool              `json:"allBrowsers,omitempty"`
	Events              []model.EventType `json:"events,omitempty"`
	SessionID           string            `json:"sessionId,omitempty"`
	NotifyMissingWindow bool              `json:"-"`
}

// Status reports daemon and browser connection state
type Status struct {
	PID          int             `json:"pid"`
	Socket       string          `json:"socket"`
	Browsers     []BrowserStatus `json:"browsers"`
	Capabilities []string        `json:"capabilities,omitempty"`
}

// BrowserStatus reports one connected browser
type BrowserStatus struct {
	ID      model.BrowserID `json:"id"`
	Name    string          `json:"name"`
	AppName string          `json:"appName"`
}

type daemonClient struct {
	cli           *internalcli.Client
	switcher      bool
	mu            sync.Mutex
	closed        bool
	subscriptions map[*internalcli.Client]context.CancelFunc
}

func (c *daemonClient) tabCommand(operation string) string {
	if c.switcher {
		return "switcher.tabs." + operation
	}
	return "tabs." + operation
}

func (c *daemonClient) ListTabs(ctx context.Context, opts ListTabsOptions) ([]model.Tab, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	targets, err := c.browserTargets(ctx, targetOptions{BrowserID: opts.BrowserID, AllBrowsers: opts.AllBrowsers})
	if err != nil {
		return nil, err
	}

	return collectBrowserTabs(ctx, targets, func(ctx context.Context, target BrowserStatus) ([]model.Tab, error) {
		cli, err := internalcli.Connect()
		if err != nil {
			return nil, err
		}
		defer cli.Close()
		cli.SessionID = opts.SessionID
		cli.PersonalTabID = opts.PersonalTabID
		cli.NotifyMissingWindow = opts.NotifyMissingWindow
		resp, err := cli.RequestContext(ctx, string(target.ID), internalcli.ExtCommand{
			Cmd:  c.tabCommand("list"),
			Args: map[string]any{"query": map[string]any{}},
		})
		if err != nil {
			return nil, err
		}
		var decoded commandResponse[[]model.Tab]
		if err := decodeCommandResponse(resp, &decoded); err != nil {
			return nil, err
		}
		if decoded.Error != nil {
			return nil, decoded.Error
		}
		return decoded.Data, nil
	})
}

func collectBrowserTabs(ctx context.Context, targets []BrowserStatus, fetch func(context.Context, BrowserStatus) ([]model.Tab, error)) ([]model.Tab, error) {
	type result struct {
		tabs []model.Tab
		err  error
	}
	results := make([]result, len(targets))
	var wg sync.WaitGroup
	for i, target := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i].tabs, results[i].err = fetch(ctx, target)
		}()
	}
	wg.Wait()

	var out []model.Tab
	var failures []error
	for i, result := range results {
		if result.err != nil {
			failure := fmt.Errorf("%s: %w", targets[i].ID, result.err)
			failures = append(failures, failure)
			log.Printf("browser tab listing failed: %v", failure)
			continue
		}
		for _, tab := range result.tabs {
			fillTabBrowser(&tab, targets[i])
			out = append(out, tab)
		}
	}
	if len(failures) == len(targets) {
		return nil, errors.Join(failures...)
	}
	return out, nil
}

func (c *daemonClient) FocusTab(ctx context.Context, req FocusTabRequest) (FocusTabResult, error) {
	if err := ctx.Err(); err != nil {
		return FocusTabResult{}, err
	}
	if req.BrowserID == "" {
		return FocusTabResult{}, errors.New("browserId is required")
	}
	args := map[string]any{"tabId": req.TabID}
	if !c.switcher {
		args["sessionId"] = req.SessionID
		args["allowFocus"] = req.AllowFocus
		if req.PersonalTabID > 0 {
			args["personalTabId"] = req.PersonalTabID
		}
	}
	if req.WindowID > 0 {
		args["windowId"] = req.WindowID
	}
	resp, err := c.cli.RequestContext(ctx, string(req.BrowserID), internalcli.ExtCommand{Cmd: c.tabCommand("focus"), Args: args})
	if err != nil {
		return FocusTabResult{}, err
	}
	var decoded commandResponse[FocusTabResult]
	if err := decodeCommandResponse(resp, &decoded); err != nil {
		return FocusTabResult{}, err
	}
	if decoded.Error != nil {
		return FocusTabResult{}, decoded.Error
	}
	decoded.Data.BrowserID = req.BrowserID
	if decoded.Data.TabID == 0 {
		decoded.Data.TabID = req.TabID
	}
	return decoded.Data, nil
}

func (c *daemonClient) CloseTab(ctx context.Context, req CloseTabRequest) error {
	targets, err := c.browserTargets(ctx, targetOptions{BrowserID: req.BrowserID})
	if err != nil {
		return err
	}
	args := map[string]any{"tabId": req.TabID}
	if !c.switcher {
		args["sessionId"] = req.SessionID
	}
	resp, err := c.cli.RequestContext(ctx, string(targets[0].ID), internalcli.ExtCommand{Cmd: c.tabCommand("close"), Args: args})
	if err != nil {
		return err
	}
	var decoded commandResponse[json.RawMessage]
	if err := decodeCommandResponse(resp, &decoded); err != nil {
		return err
	}
	if decoded.Error != nil {
		return decoded.Error
	}
	return nil
}

func (c *daemonClient) Subscribe(ctx context.Context, opts SubscribeOptions) (<-chan model.Event, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	subscription, err := internalcli.Connect()
	if err != nil {
		return nil, err
	}
	subscription.SessionID = opts.SessionID
	subscription.NotifyMissingWindow = opts.NotifyMissingWindow
	ctx, cancel := context.WithCancel(ctx)
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		cancel()
		_ = subscription.Close()
		return nil, net.ErrClosed
	}
	if c.subscriptions == nil {
		c.subscriptions = make(map[*internalcli.Client]context.CancelFunc)
	}
	c.subscriptions[subscription] = cancel
	c.mu.Unlock()
	stop := context.AfterFunc(ctx, func() { _ = subscription.Close() })
	cleanup := func() {
		cancel()
		stop()
		_ = subscription.Close()
		c.mu.Lock()
		delete(c.subscriptions, subscription)
		c.mu.Unlock()
	}
	started := false
	defer func() {
		if !started {
			cleanup()
		}
	}()
	if wantsTabEvents(opts.Events) {
		targets, err := (&daemonClient{cli: subscription}).browserTargets(ctx, targetOptions{BrowserID: opts.BrowserID, AllBrowsers: opts.AllBrowsers})
		if err != nil {
			if !opts.AllBrowsers || !wantsLifecycleEvents(opts.Events) {
				return nil, err
			}
		}
		// one stale browser must not starve the others, so all-browser
		// subscriptions only fail when no browser accepted and nothing else is wanted
		var errs []error
		for _, target := range targets {
			if err := c.subscribeBrowserTabs(ctx, subscription, target.ID, opts.Events); err != nil {
				if !opts.AllBrowsers {
					return nil, err
				}
				errs = append(errs, fmt.Errorf("%s: %w", target.ID, err))
			}
		}
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if len(errs) > 0 && len(errs) == len(targets) && !wantsLifecycleEvents(opts.Events) {
			return nil, errors.Join(errs...)
		}
	}
	// tab subscriptions are per browser, so extend all-browser subscriptions
	// to browsers that connect later
	followConnects := opts.AllBrowsers && wantsTabEvents(opts.Events)

	out := make(chan model.Event, 32)
	started = true
	go func() {
		defer close(out)
		defer cleanup()
		for {
			env, err := subscription.ReadEvent()
			if err != nil {
				return
			}
			evt, ok := decodeEventEnvelope(env, nil, c.tabCommand("event"))
			if !ok {
				continue
			}
			if followConnects && evt.Type == model.EventTypeBrowserConnected && evt.BrowserID != "" {
				// best effort: a failure only loses this browser's tab events
				_ = c.subscribeBrowserTabs(ctx, subscription, evt.BrowserID, opts.Events)
			}
			if !eventAllowed(evt.Type, opts.Events) {
				continue
			}
			if opts.BrowserID != "" && evt.BrowserID != opts.BrowserID {
				continue
			}
			select {
			case out <- evt:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out, nil
}

// subscribeBrowserTabs asks one browser to stream tab events on this connection.
// Callers must not read the connection concurrently.
func (c *daemonClient) subscribeBrowserTabs(ctx context.Context, subscription *internalcli.Client, browserID model.BrowserID, types []model.EventType) error {
	resp, err := subscription.RequestContext(ctx, string(browserID), internalcli.ExtCommand{
		Cmd:  c.tabCommand("subscribe"),
		Args: map[string]any{"events": browserEventNames(types)},
	})
	if err != nil {
		return err
	}
	var decoded commandResponse[json.RawMessage]
	if err := decodeCommandResponse(resp, &decoded); err != nil {
		return err
	}
	if decoded.Error != nil {
		return decoded.Error
	}
	return nil
}

func (c *daemonClient) Status(ctx context.Context) (Status, error) {
	if err := ctx.Err(); err != nil {
		return Status{}, err
	}
	resp, err := c.cli.RequestContext(ctx, "daemon", internalcli.ExtCommand{Cmd: "status"})
	if err != nil {
		return Status{}, err
	}
	var decoded commandResponse[daemonStatus]
	if err := decodeCommandResponse(resp, &decoded); err != nil {
		return Status{}, err
	}
	if decoded.Error != nil {
		return Status{}, decoded.Error
	}

	status := Status{PID: decoded.Data.PID, Socket: decoded.Data.Socket, Capabilities: decoded.Data.Capabilities}
	for _, conn := range decoded.Data.Connections {
		if conn.Role != string(protocol.RoleBrowser) {
			continue
		}
		status.Browsers = append(status.Browsers, BrowserStatus{
			ID:      model.BrowserID(conn.ID),
			Name:    conn.Browser,
			AppName: appNameForBrowser(conn.Browser),
		})
	}
	sort.Slice(status.Browsers, func(i, j int) bool { return status.Browsers[i].ID < status.Browsers[j].ID })
	return status, nil
}

func (c *daemonClient) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	for _, cancel := range c.subscriptions {
		cancel()
	}
	c.mu.Unlock()
	return c.cli.Close()
}

type targetOptions struct {
	BrowserID   model.BrowserID
	AllBrowsers bool
}

func (c *daemonClient) browserTargets(ctx context.Context, opts targetOptions) ([]BrowserStatus, error) {
	if opts.BrowserID != "" {
		status, err := c.Status(ctx)
		if err == nil {
			ids := make([]string, 0, len(status.Browsers))
			for _, browser := range status.Browsers {
				ids = append(ids, string(browser.ID))
			}
			resolved, err := ResolveBrowserAlias(string(opts.BrowserID), ids)
			if err != nil {
				return nil, err
			}
			for _, browser := range status.Browsers {
				if string(browser.ID) == resolved {
					return []BrowserStatus{browser}, nil
				}
			}
		}
		name := BrowserNameFromID(string(opts.BrowserID))
		return []BrowserStatus{{ID: opts.BrowserID, Name: name, AppName: appNameForBrowser(name)}}, nil
	}

	status, err := c.Status(ctx)
	if err != nil {
		return nil, err
	}
	if len(status.Browsers) == 0 {
		return nil, errors.New("no browsers connected")
	}
	if opts.AllBrowsers {
		return status.Browsers, nil
	}
	if len(status.Browsers) > 1 {
		ids := make([]string, 0, len(status.Browsers))
		for _, browser := range status.Browsers {
			ids = append(ids, string(browser.ID))
		}
		return nil, fmt.Errorf("multiple browsers connected: %s; specify BrowserID or AllBrowsers", strings.Join(ids, ", "))
	}
	return status.Browsers, nil
}

type commandResponse[T any] struct {
	Cmd   string        `json:"cmd"`
	Data  T             `json:"data"`
	Error *CommandError `json:"error,omitempty"`
}

// CommandError is a structured error returned by the daemon or extension
type CommandError = internalcli.CommandError

func decodeCommandResponse[T any](raw json.RawMessage, out *commandResponse[T]) error {
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decoding command response: %w", err)
	}
	return nil
}

type daemonStatus struct {
	PID          int              `json:"pid"`
	Socket       string           `json:"socket"`
	Connections  []daemonConnInfo `json:"connections"`
	Capabilities []string         `json:"capabilities"`
}

type daemonConnInfo struct {
	ID      string `json:"id"`
	Role    string `json:"role"`
	Browser string `json:"browser,omitempty"`
}

func fillTabBrowser(tab *model.Tab, browser BrowserStatus) {
	tab.BrowserID = browser.ID
	if browser.Name != "" {
		tab.BrowserName = browser.Name
	}
	if browser.AppName != "" {
		tab.AppName = browser.AppName
	}
}

func browserEventNames(types []model.EventType) []string {
	if len(types) == 0 {
		return []string{"onCreated", "onRemoved", "onUpdated", "onActivated"}
	}
	seen := map[string]bool{}
	var out []string
	for _, typ := range types {
		var name string
		switch typ {
		case model.EventTypeTabCreated:
			name = "onCreated"
		case model.EventTypeTabRemoved:
			name = "onRemoved"
		case model.EventTypeTabUpdated:
			name = "onUpdated"
		case model.EventTypeTabFocused:
			name = "onActivated"
		default:
			continue
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	return out
}

func wantsTabEvents(types []model.EventType) bool {
	if len(types) == 0 {
		return true
	}
	for _, typ := range types {
		switch typ {
		case model.EventTypeTabCreated, model.EventTypeTabRemoved, model.EventTypeTabUpdated, model.EventTypeTabFocused:
			return true
		}
	}
	return false
}

func wantsLifecycleEvents(types []model.EventType) bool {
	if len(types) == 0 {
		return true
	}
	for _, typ := range types {
		switch typ {
		case model.EventTypeBrowserConnected, model.EventTypeBrowserDisconnected:
			return true
		}
	}
	return false
}

func decodeEventEnvelope(env *protocol.Envelope, allowed []model.EventType, tabEventCommand string) (model.Event, bool) {
	if env == nil || env.Type != protocol.MsgEvent {
		return model.Event{}, false
	}
	var payload struct {
		Cmd  string          `json:"cmd"`
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		return model.Event{}, false
	}

	var evt model.Event
	var ok bool
	switch payload.Cmd {
	case tabEventCommand:
		evt, ok = decodeBrowserEvent(payload.Data)
	case "browser.event":
		evt, ok = decodeBrowserLifecycleEvent(payload.Data)
	default:
		return model.Event{}, false
	}
	if !ok {
		return model.Event{}, false
	}
	fillEventBrowser(&evt, model.BrowserID(env.Source))
	if !eventAllowed(evt.Type, allowed) {
		return model.Event{}, false
	}
	return evt, true
}

func decodeBrowserEvent(raw json.RawMessage) (model.Event, bool) {
	var evt model.Event
	if err := json.Unmarshal(raw, &evt); err == nil && evt.Type != "" {
		return evt, true
	}

	var legacy struct {
		Event      string          `json:"event"`
		Tab        *model.Tab      `json:"tab,omitempty"`
		TabID      int64           `json:"tabId,omitempty"`
		ActiveInfo json.RawMessage `json:"activeInfo,omitempty"`
		RemoveInfo json.RawMessage `json:"removeInfo,omitempty"`
	}
	if err := json.Unmarshal(raw, &legacy); err != nil || legacy.Event == "" {
		return model.Event{}, false
	}

	evt.Type = eventTypeFromBrowserEvent(legacy.Event)
	if evt.Type == "" {
		return model.Event{}, false
	}
	if legacy.Tab != nil {
		evt.Tab = legacy.Tab
		evt.TabID = &model.TabID{Browser: legacy.Tab.BrowserID, WindowID: legacy.Tab.WindowID, TabID: legacy.Tab.ID}
	} else if legacy.TabID != 0 {
		evt.TabID = &model.TabID{TabID: legacy.TabID}
	}
	return evt, true
}

func decodeBrowserLifecycleEvent(raw json.RawMessage) (model.Event, bool) {
	var evt model.Event
	if err := json.Unmarshal(raw, &evt); err != nil || evt.Type == "" {
		return model.Event{}, false
	}
	switch evt.Type {
	case model.EventTypeBrowserConnected, model.EventTypeBrowserDisconnected:
		return evt, true
	default:
		return model.Event{}, false
	}
}

func fillEventBrowser(evt *model.Event, source model.BrowserID) {
	if evt.BrowserID == "" {
		evt.BrowserID = source
	}
	if evt.Tab != nil {
		if evt.Tab.BrowserID == "" {
			evt.Tab.BrowserID = source
		}
		name := BrowserNameFromID(string(evt.Tab.BrowserID))
		if name != "" {
			evt.Tab.BrowserName = name
			evt.Tab.AppName = appNameForBrowser(name)
		}
		if evt.TabID == nil {
			evt.TabID = &model.TabID{Browser: evt.Tab.BrowserID, WindowID: evt.Tab.WindowID, TabID: evt.Tab.ID}
		}
	}
	if evt.TabID != nil && evt.TabID.Browser == "" {
		evt.TabID.Browser = source
	}
}

func eventAllowed(typ model.EventType, allowed []model.EventType) bool {
	if len(allowed) == 0 {
		return true
	}
	for _, item := range allowed {
		if item == typ {
			return true
		}
	}
	return false
}

func eventTypeFromBrowserEvent(name string) model.EventType {
	switch name {
	case "onCreated":
		return model.EventTypeTabCreated
	case "onRemoved":
		return model.EventTypeTabRemoved
	case "onUpdated":
		return model.EventTypeTabUpdated
	case "onActivated":
		return model.EventTypeTabFocused
	default:
		return ""
	}
}

// BrowserNameFromID returns the browser name part of a connection ID ("zen-01" -> "zen")
func BrowserNameFromID(id string) string {
	if prefix, _, ok := strings.Cut(id, "-"); ok {
		return prefix
	}
	return id
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
