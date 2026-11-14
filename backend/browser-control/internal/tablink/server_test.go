package tablink

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/latentbyte/lbcat/backend/browser-control/internal/raise"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol"
	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol/model"
)

const testLink = "http://127.0.0.1:47823/tab/zen-01/42"

// fakeClient is one connected zen browser holding tab 42 and the tab the link opened in
type fakeClient struct {
	mu       sync.Mutex
	focusErr error
	focused  []int64
	closed   chan int64
}

func (f *fakeClient) ListTabs(context.Context, browsercontrol.ListTabsOptions) ([]model.Tab, error) {
	return []model.Tab{
		{BrowserID: "zen-01", AppName: "Zen", ID: 42, WindowID: 3, Title: "Create app", Active: true},
		{BrowserID: "zen-01", AppName: "Zen", ID: 77, WindowID: 9, URL: testLink, Active: true},
	}, nil
}

func (f *fakeClient) FocusTab(_ context.Context, req browsercontrol.FocusTabRequest) (browsercontrol.FocusTabResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.focusErr != nil {
		return browsercontrol.FocusTabResult{}, f.focusErr
	}
	f.focused = append(f.focused, req.TabID)
	return browsercontrol.FocusTabResult{BrowserID: req.BrowserID, TabID: req.TabID, WindowID: 3}, nil
}

func (f *fakeClient) CloseTab(_ context.Context, req browsercontrol.CloseTabRequest) error {
	f.closed <- req.TabID
	return nil
}

func (f *fakeClient) Subscribe(context.Context, browsercontrol.SubscribeOptions) (<-chan model.Event, error) {
	return nil, errors.New("unused")
}

func (f *fakeClient) Status(context.Context) (browsercontrol.Status, error) {
	return browsercontrol.Status{Browsers: []browsercontrol.BrowserStatus{{ID: "zen-01", Name: "zen"}}}, nil
}

func (f *fakeClient) Close() error { return nil }

type recordingRaiser struct{ raised chan model.Tab }

func (recordingRaiser) Name() string { return "recording" }

func (r recordingRaiser) Locate(_ context.Context, tab model.Tab, _ []model.Tab) (func(context.Context) error, error) {
	return func(context.Context) error {
		r.raised <- tab
		return nil
	}, nil
}

func newTestServer(client *fakeClient, raised chan model.Tab) *Server {
	return &Server{
		Connect:    func(context.Context) (browsercontrol.Client, error) { return client, nil },
		Raisers:    func() []raise.Raiser { return []raise.Raiser{recordingRaiser{raised: raised}} },
		OpenerWait: 50 * time.Millisecond,
	}
}

func linkRequest(headers map[string]string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, testLink, nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	return request
}

func TestServer(t *testing.T) {
	external := map[string]string{"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate"}

	t.Run("从外部打开链接时聚焦标签、抬起窗口并关闭打开链接的标签", func(t *testing.T) {
		client := &fakeClient{closed: make(chan int64, 1)}
		raised := make(chan model.Tab, 1)
		recorder := httptest.NewRecorder()
		newTestServer(client, raised).ServeHTTP(recorder, linkRequest(external))
		if recorder.Code != http.StatusOK || !strings.Contains(recorder.Body.String(), "Brought tab 42 in zen-01 forward") {
			t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
		}
		if tab := <-raised; tab.ID != 42 || tab.BrowserID != "zen-01" {
			t.Fatalf("raised = %+v", tab)
		}
		select {
		case closed := <-client.closed:
			if closed != 77 {
				t.Fatalf("closed tab %d, want the opener 77", closed)
			}
		case <-time.After(time.Second):
			t.Fatal("opener tab not closed")
		}
	})

	t.Run("聚焦失败时返回转义后的错误页且不关闭打开链接的标签", func(t *testing.T) {
		client := &fakeClient{closed: make(chan int64, 1), focusErr: errors.New("<tab gone>")}
		recorder := httptest.NewRecorder()
		newTestServer(client, make(chan model.Tab, 1)).ServeHTTP(recorder, linkRequest(external))
		if recorder.Code != http.StatusBadGateway || !strings.Contains(recorder.Body.String(), "&lt;tab gone&gt;") {
			t.Fatalf("response = %d %s", recorder.Code, recorder.Body.String())
		}
		select {
		case closed := <-client.closed:
			t.Fatalf("closed tab %d after a failed focus", closed)
		case <-time.After(150 * time.Millisecond):
		}
	})

	t.Run("拒绝网页发起的请求、非 GET 和其他 Host", func(t *testing.T) {
		post := linkRequest(nil)
		post.Method = http.MethodPost
		rebound := linkRequest(nil)
		rebound.Host = "evil.example:47823"
		for name, request := range map[string]*http.Request{
			"cross-site navigation": linkRequest(map[string]string{"Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate"}),
			"same-site fetch":       linkRequest(map[string]string{"Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors"}),
			"no-cors subresource":   linkRequest(map[string]string{"Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "no-cors"}),
			"post":                  post,
			"rebound host":          rebound,
		} {
			client := &fakeClient{closed: make(chan int64, 1)}
			recorder := httptest.NewRecorder()
			newTestServer(client, make(chan model.Tab, 1)).ServeHTTP(recorder, request)
			if recorder.Code < 400 || len(client.focused) != 0 {
				t.Errorf("%s: status %d, focused %v", name, recorder.Code, client.focused)
			}
		}
	})

	t.Run("非链接路径返回 404", func(t *testing.T) {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, "http://127.0.0.1:47823/", nil)
		newTestServer(&fakeClient{closed: make(chan int64, 1)}, make(chan model.Tab, 1)).ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotFound {
			t.Fatalf("status = %d", recorder.Code)
		}
	})
}
