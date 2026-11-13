package cmd

import (
	"encoding/json"
	"testing"
)

func TestLinkHandlerScript(t *testing.T) {
	t.Run("以绝对路径调用 CLI 并转义路径中的引号", func(t *testing.T) {
		script := linkHandlerScript(`/Users/o'neil/my "bin"/browser-control`)
		want := "on open location tabLink\n" +
			`	do shell script "'/Users/o'\\''neil/my \"bin\"/browser-control' human tabs focus " & quoted form of tabLink` + "\n" +
			"end open location\n"
		if script != want {
			t.Fatalf("script =\n%s\nwant\n%s", script, want)
		}
	})

	t.Run("注册 lbcat 协议", func(t *testing.T) {
		var types []struct {
			Name    string   `json:"CFBundleURLName"`
			Schemes []string `json:"CFBundleURLSchemes"`
		}
		if err := json.Unmarshal([]byte(linkHandlerURLTypes()), &types); err != nil {
			t.Fatal(err)
		}
		if len(types) != 1 || types[0].Name != linkHandlerBundleID || len(types[0].Schemes) != 1 || types[0].Schemes[0] != "lbcat" {
			t.Fatalf("types = %+v", types)
		}
	})
}
