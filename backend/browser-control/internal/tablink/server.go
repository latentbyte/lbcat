package tablink

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log"
	"net"
	"net/http"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/raise"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol"
)

// Server answers http tab links: opening one focuses the tab, then closes the browser tab the link opened in
type Server struct {
	Connect func(context.Context) (browsercontrol.Client, error)
	Raisers func() []raise.Raiser
	// OpenerWait bounds the search for the tab the link opened in
	OpenerWait time.Duration
}

// NewServer connects to the daemon as a tab switcher and raises windows with the machine's default raisers
func NewServer() *Server {
	return &Server{Connect: browsercontrol.NewSwitcher, Raisers: raise.Default, OpenerWait: 3 * time.Second}
}

// Run serves tab links for the daemon until ctx ends; without the port, links fail but the daemon keeps routing
func Run(ctx context.Context) {
	if err := NewServer().Serve(ctx); err != nil {
		log.Printf("%v", err)
	}
}

// Serve listens on browsercontrol.LinkHost until ctx ends
func (s *Server) Serve(ctx context.Context) error {
	listener, err := net.Listen("tcp", browsercontrol.LinkHost)
	if err != nil {
		return fmt.Errorf("tab links unavailable: %w", err)
	}
	server := &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		_ = server.Close()
	}()
	if err := server.Serve(listener); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if status, reason := rejectRequest(r); status != 0 {
		http.Error(w, reason, status)
		return
	}
	link := "http://" + browsercontrol.LinkHost + r.URL.Path
	browserID, tabID, err := browsercontrol.ParseTabLink(link)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	client, err := s.Connect(ctx)
	if err != nil {
		writePage(w, http.StatusServiceUnavailable, "Browser Control is not reachable: "+err.Error())
		return
	}
	defer client.Close()
	connected, err := Connected(ctx, client)
	if err == nil {
		browserID, err = Resolve(ctx, client, browserID, tabID, connected)
	}
	if err == nil {
		_, err = Focus(ctx, client, browserID, tabID, s.Raisers())
	}
	if err != nil {
		log.Printf("tab link %s: %v", r.URL.Path, err)
		writePage(w, http.StatusBadGateway, "Could not bring the tab forward: "+err.Error())
		return
	}
	writePage(w, http.StatusOK, fmt.Sprintf("Brought tab %d in %s forward. You can close this tab.", tabID, browserID))
	go s.closeOpener(link)
}

// rejectRequest admits only page navigations the user started outside a web page, eg a link opened from a chat app.
// Browsers set Sec-Fetch-* themselves, so another site cannot fetch or navigate here to steal focus; the Host check
// stops DNS rebinding. Clients that send no Sec-Fetch headers are local tools, which can reach the daemon anyway
func rejectRequest(r *http.Request) (int, string) {
	if r.Method != http.MethodGet {
		return http.StatusMethodNotAllowed, "tab links only answer GET"
	}
	if r.Host != browsercontrol.LinkHost {
		return http.StatusForbidden, "unexpected host"
	}
	if site := r.Header.Get("Sec-Fetch-Site"); site != "" && site != "none" {
		return http.StatusForbidden, "tab links only open from outside web pages"
	}
	if mode := r.Header.Get("Sec-Fetch-Mode"); mode != "" && mode != "navigate" {
		return http.StatusForbidden, "tab links only open as a page"
	}
	return 0, ""
}

// closeOpener closes the tab the link opened in, when it is in a browser running LBcat
func (s *Server) closeOpener(link string) {
	ctx, cancel := context.WithTimeout(context.Background(), s.OpenerWait+5*time.Second)
	defer cancel()
	client, err := s.Connect(ctx)
	if err != nil {
		return
	}
	defer client.Close()
	deadline := time.Now().Add(s.OpenerWait)
	for {
		tabs, err := client.ListTabs(ctx, browsercontrol.ListTabsOptions{AllBrowsers: true})
		if err != nil {
			return
		}
		closed := false
		for _, tab := range tabs {
			if tab.URL != link {
				continue
			}
			if err := client.CloseTab(ctx, browsercontrol.CloseTabRequest{BrowserID: tab.BrowserID, TabID: tab.ID}); err != nil {
				log.Printf("closing tab link opener %s/%d: %v", tab.BrowserID, tab.ID, err)
			}
			closed = true
		}
		if closed || !time.Now().Before(deadline) {
			return
		}
		// the response is in flight, so the opener tab normally lists its URL within a few polls
		time.Sleep(200 * time.Millisecond)
	}
}

func writePage(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>LBcat tab link</title><p style="font:16px system-ui;margin:2em">%s</p>`, html.EscapeString(message))
}
