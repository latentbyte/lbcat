package cmd

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/latentbyte/lbcat/backend/browser-control/pkg/browsercontrol"
)

// macOS delivers a clicked URL to its handler app as an Apple Event, not as an argument, so the handler is a small
// AppleScript applet that hands the link to "human tabs focus"
const (
	linkHandlerName     = "LBcat Links.app"
	linkHandlerBundleID = "com.latentbyte.lbcat.links"
	lsregister          = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
)

func linkHandlerPath(home string) string {
	return filepath.Join(home, "Applications", linkHandlerName)
}

// linkHandlerScript runs the CLI by absolute path: the applet's shell has a minimal PATH
func linkHandlerScript(cliPath string) string {
	command := appleScriptString(shellQuote(cliPath) + " human tabs focus ")
	return "on open location tabLink\n\tdo shell script " + command + " & quoted form of tabLink\nend open location\n"
}

func linkHandlerURLTypes() string {
	return fmt.Sprintf(`[{"CFBundleURLName":%q,"CFBundleURLSchemes":[%q]}]`, linkHandlerBundleID, browsercontrol.LinkScheme)
}

// installLinkHandler builds the applet, registers it for lbcat:// links, and replaces an earlier copy
func installLinkHandler(home, cliPath string) (string, error) {
	work, err := os.MkdirTemp("", "lbcat-links-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(work)
	script := filepath.Join(work, "links.applescript")
	if err := os.WriteFile(script, []byte(linkHandlerScript(cliPath)), 0o600); err != nil {
		return "", err
	}
	built := filepath.Join(work, linkHandlerName)
	plist := filepath.Join(built, "Contents", "Info.plist")
	steps := [][]string{
		{"/usr/bin/osacompile", "-o", built, script},
		{"/usr/bin/plutil", "-replace", "CFBundleIdentifier", "-string", linkHandlerBundleID, plist},
		{"/usr/bin/plutil", "-replace", "LSUIElement", "-bool", "YES", plist},
		{"/usr/bin/plutil", "-replace", "CFBundleURLTypes", "-json", linkHandlerURLTypes(), plist},
		{"/usr/bin/codesign", "--force", "--sign", "-", built},
	}
	for _, step := range steps {
		if output, err := exec.Command(step[0], step[1:]...).CombinedOutput(); err != nil {
			return "", fmt.Errorf("%s: %w: %s", filepath.Base(step[0]), err, strings.TrimSpace(string(output)))
		}
	}
	target := linkHandlerPath(home)
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return "", err
	}
	if err := os.RemoveAll(target); err != nil {
		return "", err
	}
	if err := os.Rename(built, target); err != nil {
		return "", err
	}
	if output, err := exec.Command(lsregister, "-f", target).CombinedOutput(); err != nil {
		return "", fmt.Errorf("lsregister: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return target, nil
}

// uninstallLinkHandler unregisters and removes the applet; it reports whether one was installed
func uninstallLinkHandler(home string) (bool, error) {
	target := linkHandlerPath(home)
	if _, err := os.Stat(target); err != nil {
		return false, nil
	}
	_ = exec.Command(lsregister, "-u", target).Run()
	return true, os.RemoveAll(target)
}

func shellQuote(word string) string {
	return "'" + strings.ReplaceAll(word, "'", `'\''`) + "'"
}

func appleScriptString(text string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(text) + `"`
}
