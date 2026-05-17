package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/protocol"
	"github.com/spf13/cobra"
)

// browserInfo holds the manifest directory paths and manifest style for a browser.
type browserInfo struct {
	dirs          map[string][]string // OS -> candidate relative paths from $HOME
	manifestStyle string              // "chrome" or "firefox"
}

var userDataDirRE = regexp.MustCompile(`--user-data-dir(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^"'[:space:]]+))`)

// browserManifestDirs maps browser names to their native messaging host
// manifest directories per OS and their manifest style.
var browserRegistry = map[string]browserInfo{
	"chrome": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/Google/Chrome/NativeMessagingHosts"},
			"linux":  {".config/google-chrome/NativeMessagingHosts"},
		},
		manifestStyle: "chrome",
	},
	"brave": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"},
			"linux":  {".config/BraveSoftware/Brave-Browser/NativeMessagingHosts"},
		},
		manifestStyle: "chrome",
	},
	"chromium": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/Chromium/NativeMessagingHosts"},
			"linux":  {".config/chromium/NativeMessagingHosts"},
		},
		manifestStyle: "chrome",
	},
	"vivaldi": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/Vivaldi/NativeMessagingHosts"},
			"linux":  {".config/vivaldi/NativeMessagingHosts"},
		},
		manifestStyle: "chrome",
	},
	"edge": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/Microsoft Edge/NativeMessagingHosts"},
			"linux":  {".config/microsoft-edge/NativeMessagingHosts"},
		},
		manifestStyle: "chrome",
	},
	"opera": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/com.operasoftware.Opera/NativeMessagingHosts"},
			"linux":  {".config/opera/NativeMessagingHosts"},
		},
		manifestStyle: "chrome",
	},
	"firefox": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/Mozilla/NativeMessagingHosts"},
			"linux":  {".mozilla/native-messaging-hosts"},
		},
		manifestStyle: "firefox",
	},
	"zen": {
		dirs: map[string][]string{
			"darwin": {
				"Library/Application Support/zen/NativeMessagingHosts",
				"Library/Application Support/Zen/NativeMessagingHosts",
			},
			"linux": {".zen/native-messaging-hosts"},
		},
		manifestStyle: "firefox",
	},
	"waterfox": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/Waterfox/NativeMessagingHosts"},
			"linux":  {".waterfox/native-messaging-hosts"},
		},
		manifestStyle: "firefox",
	},
	"librewolf": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/LibreWolf/NativeMessagingHosts"},
			"linux":  {".librewolf/native-messaging-hosts"},
		},
		manifestStyle: "firefox",
	},
	"floorp": {
		dirs: map[string][]string{
			"darwin": {"Library/Application Support/Floorp/NativeMessagingHosts"},
			"linux":  {".floorp/native-messaging-hosts"},
		},
		manifestStyle: "firefox",
	},
}

// extensionRegistry holds known published extension IDs per extension, keyed by manifest style.
type extensionRegistry struct {
	hostName    string            // native messaging host name
	description string            // human-readable description
	knownIDs    map[string]string // "chrome" or "firefox" -> store extension ID
}

var extensions = []extensionRegistry{
	{
		hostName:    protocol.HostName,
		description: "Browser Control bridge",
		knownIDs: map[string]string{
			"chrome":  "ndcooeababalnlpkfedmmbbbgkljhpjf",
			"firefox": "scriptcat@latentbyte.com",
		},
	},
}

// extIDForBrowser returns the known extension ID for a given registry entry
// based on the browser's manifest style.
func extIDForBrowser(browser string, reg extensionRegistry) string {
	if id, ok := reg.knownIDs[browser]; ok {
		return id
	}
	info, ok := browserRegistry[browser]
	if !ok {
		return ""
	}
	// firefox forks use the same addon ID, chromium forks use the same chrome ID
	return reg.knownIDs[info.manifestStyle]
}

type chromeManifest struct {
	Name           string   `json:"name"`
	Description    string   `json:"description"`
	Path           string   `json:"path"`
	Type           string   `json:"type"`
	AllowedOrigins []string `json:"allowed_origins,omitempty"`
}

type firefoxManifest struct {
	Name              string   `json:"name"`
	Description       string   `json:"description"`
	Path              string   `json:"path"`
	Type              string   `json:"type"`
	AllowedExtensions []string `json:"allowed_extensions,omitempty"`
}

var installCmd = &cobra.Command{
	Use:   "install",
	Short: "Register native host manifests for detected browsers",
	Long: `Detects installed browsers and writes native messaging host manifests
that point to the lbcat-shim binary. This allows LBCat to communicate
with Browser Control via the shared daemon.

For dev builds (unpacked extensions), use --dev to also allow the extension ID
found in dist/manifest.json, or pass --extension-id explicitly.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		shimPath, err := findShimBinary()
		if err != nil {
			return err
		}

		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("cannot determine home directory: %w", err)
		}

		extID, _ := cmd.Flags().GetString("extension-id")
		devMode, _ := cmd.Flags().GetBool("dev")

		// in dev mode, try to read local extension IDs for unpacked builds
		devFirefoxID := ""
		var devChromeIDs []string
		if devMode {
			devFirefoxID = readDevFirefoxID()
			devChromeIDs, _ = readDevChromeIDs(home)
		}

		installed := 0

		for browser, info := range browserRegistry {
			targets, err := manifestTargetDirs(home, browser, info)
			if err != nil {
				fmt.Fprintf(os.Stderr, "warning: cannot inspect %s targets: %v\n", browser, err)
			}
			if len(targets) == 0 {
				continue
			}

			for _, reg := range extensions {
				data, err := buildManifestData(info, browser, shimPath, extID, devMode, devFirefoxID, devChromeIDs, reg)
				if err != nil {
					return err
				}

				for _, targetDir := range targets {
					if err := os.MkdirAll(targetDir, 0o755); err != nil {
						fmt.Fprintf(os.Stderr, "warning: cannot create %s: %v\n", targetDir, err)
						continue
					}

					manifestFile := filepath.Join(targetDir, reg.hostName+".json")
					if err := os.WriteFile(manifestFile, data, 0o644); err != nil {
						fmt.Fprintf(os.Stderr, "warning: cannot write %s: %v\n", manifestFile, err)
						continue
					}

					fmt.Printf("installed: %s [%s] -> %s\n", browser, reg.hostName, manifestFile)
					installed++
				}
			}
		}

		if installed == 0 {
			fmt.Println("no browsers detected")
		} else {
			fmt.Printf("\n%d manifest(s) installed, shim: %s\n", installed, shimPath)
			if devMode {
				fmt.Println("dev mode: accepting any extension ID for Chrome/Brave")
				if len(devChromeIDs) > 0 {
					fmt.Printf("dev mode: chrome-family extension IDs from profiles: %s\n", strings.Join(devChromeIDs, ", "))
				}
				if devFirefoxID != "" {
					fmt.Printf("dev mode: firefox addon ID from dist/: %s\n", devFirefoxID)
				}
			}
		}
		return nil
	},
}

// buildChromeOrigins returns the allowed_origins list for a Chrome manifest.
// In dev mode, we include a wildcard-style match by not restricting to a
// specific ID (Chrome doesn't support wildcards, so we include both the known
// store ID and the user-provided one).
func buildChromeOrigins(extID string, devMode bool, browser string, devChromeIDs []string, reg extensionRegistry) []string {
	var origins []string

	// always include the known store ID
	storeID := extIDForBrowser(browser, reg)
	if storeID != "" {
		origins = append(origins, "chrome-extension://"+storeID+"/")
	}

	// explicit override
	if extID != "" && extID != storeID {
		origin := extID
		if !strings.HasPrefix(origin, "chrome-extension://") {
			origin = "chrome-extension://" + origin + "/"
		}
		origins = append(origins, origin)
	}

	if devMode {
		for _, devID := range devChromeIDs {
			if devID == "" || devID == storeID || devID == extID {
				continue
			}
			origins = append(origins, "chrome-extension://"+devID+"/")
		}
	}

	return uniqStrings(origins)
}

func buildManifestData(info browserInfo, browser, shimPath, extID string, devMode bool, devFirefoxID string, devChromeIDs []string, reg extensionRegistry) ([]byte, error) {
	if info.manifestStyle == "firefox" {
		ids := buildFirefoxIDs(extID, devFirefoxID, browser, reg)
		m := firefoxManifest{
			Name:              reg.hostName,
			Description:       reg.description,
			Path:              shimPath,
			Type:              "stdio",
			AllowedExtensions: ids,
		}
		return json.MarshalIndent(m, "", "  ")
	}

	origins := buildChromeOrigins(extID, devMode, browser, devChromeIDs, reg)
	m := chromeManifest{
		Name:           reg.hostName,
		Description:    reg.description,
		Path:           shimPath,
		Type:           "stdio",
		AllowedOrigins: origins,
	}
	return json.MarshalIndent(m, "", "  ")
}

// buildFirefoxIDs returns the allowed_extensions list for a Firefox manifest.
func buildFirefoxIDs(extID, devFirefoxID, browser string, reg extensionRegistry) []string {
	var ids []string

	storeID := extIDForBrowser(browser, reg)
	if storeID != "" {
		ids = append(ids, storeID)
	}

	if devFirefoxID != "" && devFirefoxID != storeID {
		ids = append(ids, devFirefoxID)
	}

	if extID != "" && extID != storeID && extID != devFirefoxID {
		ids = append(ids, extID)
	}

	return ids
}

// readDevFirefoxID tries to read the Firefox extension ID from dist/manifest.json.
// This handles dev/unpacked builds where the ID is set in
// browser_specific_settings.gecko.id.
func readDevFirefoxID() string {
	// look for dist/manifest.json relative to common locations
	candidates := []string{
		"dist/manifest.json",
		"../../dist/manifest.json", // from backend/browser-control/
	}

	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var manifest struct {
			BrowserSpecificSettings struct {
				Gecko struct {
					ID string `json:"id"`
				} `json:"gecko"`
			} `json:"browser_specific_settings"`
		}
		if err := json.Unmarshal(data, &manifest); err == nil {
			if id := manifest.BrowserSpecificSettings.Gecko.ID; id != "" {
				return id
			}
		}
	}
	return ""
}

func readDevChromeIDs(home string) ([]string, error) {
	distPaths, err := devDistPaths()
	if err != nil {
		return nil, err
	}
	if len(distPaths) == 0 {
		return nil, nil
	}

	var ids []string
	for browser, info := range browserRegistry {
		if info.manifestStyle != "chrome" {
			continue
		}
		targets, err := manifestTargetDirs(home, browser, info)
		if err != nil {
			continue
		}
		for _, targetDir := range targets {
			userDataDir := filepath.Dir(targetDir)
			foundIDs, err := findDevChromeIDsInUserDataDir(userDataDir, distPaths)
			if err != nil {
				continue
			}
			ids = append(ids, foundIDs...)
		}
	}
	return uniqStrings(ids), nil
}

func devDistPaths() ([]string, error) {
	candidates := []string{
		"dist",
		"../../dist",
	}
	var paths []string
	for _, candidate := range candidates {
		absPath, err := filepath.Abs(candidate)
		if err != nil {
			return nil, err
		}
		if _, err := os.Stat(absPath); err == nil {
			paths = append(paths, absPath)
		}
	}
	return uniqPaths(paths), nil
}

func findDevChromeIDsInUserDataDir(userDataDir string, distPaths []string) ([]string, error) {
	entries, err := os.ReadDir(userDataDir)
	if err != nil {
		return nil, err
	}

	var ids []string
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		prefPath := filepath.Join(userDataDir, entry.Name(), "Secure Preferences")
		foundIDs, err := findDevChromeIDsInPreferences(prefPath, distPaths)
		if err != nil {
			continue
		}
		ids = append(ids, foundIDs...)
	}
	return uniqStrings(ids), nil
}

func findDevChromeIDsInPreferences(prefPath string, distPaths []string) ([]string, error) {
	data, err := os.ReadFile(prefPath)
	if err != nil {
		return nil, err
	}

	var prefs struct {
		Extensions struct {
			Settings map[string]struct {
				Location int    `json:"location"`
				Path     string `json:"path"`
			} `json:"settings"`
		} `json:"extensions"`
	}
	if err := json.Unmarshal(data, &prefs); err != nil {
		return nil, err
	}

	var ids []string
	for id, settings := range prefs.Extensions.Settings {
		if settings.Location != 4 || settings.Path == "" {
			continue
		}
		cleanPath := filepath.Clean(settings.Path)
		if slices.Contains(distPaths, cleanPath) {
			ids = append(ids, id)
		}
	}
	return uniqStrings(ids), nil
}

func manifestTargetDirs(home, browser string, info browserInfo) ([]string, error) {
	var dirs []string
	if relDirs, ok := info.dirs[runtime.GOOS]; ok {
		for _, relDir := range relDirs {
			defaultDir := filepath.Join(home, relDir)
			if _, err := os.Stat(filepath.Dir(defaultDir)); err == nil {
				dirs = append(dirs, defaultDir)
			}
		}
	}

	if info.manifestStyle != "chrome" {
		return uniqPaths(dirs), nil
	}

	customDirs, err := detectChromeProfileManifestDirs(browser)
	if err != nil {
		return uniqPaths(dirs), err
	}
	dirs = append(dirs, customDirs...)
	return uniqPaths(dirs), nil
}

func detectChromeProfileManifestDirs(browser string) ([]string, error) {
	cmd := exec.Command("ps", "-axo", "command")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}

	var lines []string
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return chromeProfileManifestDirsFromLines(browser, lines), nil
}

func chromeProfileManifestDirsFromLines(browser string, lines []string) []string {
	markers := browserProcessMarkers(browser)
	if len(markers) == 0 {
		return nil
	}

	var dirs []string
	for _, line := range lines {
		lowerLine := strings.ToLower(line)
		if !containsAny(lowerLine, markers) {
			continue
		}
		userDataDir := extractUserDataDir(line)
		if userDataDir == "" {
			continue
		}
		dirs = append(dirs, filepath.Join(userDataDir, "NativeMessagingHosts"))
	}
	return uniqPaths(dirs)
}

func browserProcessMarkers(browser string) []string {
	switch browser {
	case "chrome":
		return []string{
			"/google chrome.app/",
			"google-chrome",
			"google chrome",
		}
	case "brave":
		return []string{
			"/brave browser.app/",
			"brave-browser",
			"brave browser",
		}
	case "chromium":
		return []string{
			"/chromium.app/",
			" ungoogled-chromium",
			"/ungoogled-chromium",
			"chromium --user-data-dir",
			"chromium --type=",
		}
	case "vivaldi":
		return []string{
			"/vivaldi.app/",
			"vivaldi-bin",
			"vivaldi ",
		}
	case "edge":
		return []string{
			"/microsoft edge.app/",
			"microsoft-edge",
			"microsoft edge",
		}
	case "opera":
		return []string{
			"/opera.app/",
			"opera --user-data-dir",
			"opera --type=",
		}
	default:
		return nil
	}
}

func extractUserDataDir(line string) string {
	matches := userDataDirRE.FindStringSubmatch(line)
	if len(matches) == 0 {
		return ""
	}
	for _, val := range matches[1:] {
		if val != "" {
			return val
		}
	}
	return ""
}

func containsAny(line string, markers []string) bool {
	for _, marker := range markers {
		if strings.Contains(line, marker) {
			return true
		}
	}
	return false
}

func uniqPaths(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	out := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			continue
		}
		cleanPath := filepath.Clean(path)
		if _, ok := seen[cleanPath]; ok {
			continue
		}
		seen[cleanPath] = struct{}{}
		out = append(out, cleanPath)
	}
	return out
}

func uniqStrings(vals []string) []string {
	seen := make(map[string]struct{}, len(vals))
	out := make([]string, 0, len(vals))
	for _, val := range vals {
		if val == "" {
			continue
		}
		if _, ok := seen[val]; ok {
			continue
		}
		seen[val] = struct{}{}
		out = append(out, val)
	}
	return out
}

var uninstallCmd = &cobra.Command{
	Use:   "uninstall",
	Short: "Remove native host manifests",
	RunE: func(cmd *cobra.Command, args []string) error {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}

		removed := 0
		for browser, info := range browserRegistry {
			targets, err := manifestTargetDirs(home, browser, info)
			if err != nil {
				fmt.Fprintf(os.Stderr, "warning: cannot inspect %s targets: %v\n", browser, err)
			}
			for _, targetDir := range targets {
				for _, reg := range extensions {
					manifestFile := filepath.Join(targetDir, reg.hostName+".json")
					if err := os.Remove(manifestFile); err == nil {
						fmt.Printf("removed: %s [%s] (%s)\n", browser, reg.hostName, manifestFile)
						removed++
					}
				}
			}
		}

		if removed == 0 {
			fmt.Println("no manifests found to remove")
		}
		return nil
	},
}

// findShimBinary locates the lbcat-shim binary.
func findShimBinary() (string, error) {
	// look next to browser-control binary
	self, err := os.Executable()
	if err == nil {
		shimPath := filepath.Join(filepath.Dir(self), "lbcat-shim")
		if _, err := os.Stat(shimPath); err == nil {
			return shimPath, nil
		}
	}

	// look in common locations
	for _, dir := range []string{
		filepath.Join(os.Getenv("HOME"), ".local", "bin"),
		"/usr/local/bin",
	} {
		shimPath := filepath.Join(dir, "lbcat-shim")
		if _, err := os.Stat(shimPath); err == nil {
			return shimPath, nil
		}
	}

	return "", fmt.Errorf("lbcat-shim not found, build and install it first")
}

func init() {
	installCmd.Flags().String("extension-id", "", "override extension ID (default: known LBCat IDs)")
	installCmd.Flags().Bool("dev", false, "dev mode: accept unpacked extension IDs, read from dist/manifest.json")
	rootCmd.AddCommand(installCmd, uninstallCmd)
}
