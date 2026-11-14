package browsercontrol

import "testing"

func TestTabLink(t *testing.T) {
	t.Run("生成的 http 链接可以解析回浏览器与标签", func(t *testing.T) {
		link := TabLink("zen-01", 116)
		if link != "http://127.0.0.1:47823/tab/zen-01/116" {
			t.Fatalf("link = %q", link)
		}
		browser, tab, err := ParseTabLink(link)
		if err != nil || browser != "zen-01" || tab != 116 || !IsTabLink(link) {
			t.Fatalf("parsed = %q %d %v", browser, tab, err)
		}
	})

	t.Run("同样接受 lbcat 协议的链接", func(t *testing.T) {
		browser, tab, err := ParseTabLink("lbcat://tab/zen-01/116")
		if err != nil || browser != "zen-01" || tab != 116 || !IsTabLink("lbcat://tab/zen-01/116") {
			t.Fatalf("parsed = %q %d %v", browser, tab, err)
		}
	})

	t.Run("标签 ID 不是链接", func(t *testing.T) {
		if IsTabLink("116") {
			t.Fatal("tab ID treated as a link")
		}
	})

	t.Run("拒绝其他主机、路径和非法标签 ID", func(t *testing.T) {
		for _, link := range []string{
			"https://127.0.0.1:47823/tab/zen-01/116",
			"http://127.0.0.1:9999/tab/zen-01/116",
			"http://example.com/tab/zen-01/116",
			"http://127.0.0.1:47823/note/zen-01/116",
			"http://127.0.0.1:47823/tab/zen-01",
			"lbcat://note/zen-01/116",
			"lbcat://tab/zen-01",
			"lbcat://tab//116",
			"lbcat://tab/zen-01/0",
			"lbcat://tab/zen-01/abc",
			"lbcat://tab/zen-01/116/extra",
		} {
			if _, _, err := ParseTabLink(link); err == nil {
				t.Errorf("%s parsed without error", link)
			}
		}
	})
}
