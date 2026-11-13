package browsercontrol

import "testing"

func TestTabLink(t *testing.T) {
	t.Run("生成的链接可以解析回浏览器与标签", func(t *testing.T) {
		link := TabLink("zen-01", 116)
		if link != "lbcat://tab/zen-01/116" {
			t.Fatalf("link = %q", link)
		}
		browser, tab, err := ParseTabLink(link)
		if err != nil || browser != "zen-01" || tab != 116 {
			t.Fatalf("parsed = %q %d %v", browser, tab, err)
		}
	})

	t.Run("拒绝其他协议、类型和非法标签 ID", func(t *testing.T) {
		for _, link := range []string{
			"https://tab/zen-01/116",
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
