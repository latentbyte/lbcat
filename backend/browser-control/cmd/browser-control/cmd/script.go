package cmd

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

// scriptArchiveDir returns the directory where pushed scripts are saved.
// Uses $BROWSER_CONTROL_SCRIPTS_DIR, then $DOTFILES_DIR/user-scripts/, then ~/dotfiles/user-scripts/.
func scriptArchiveDir() string {
	if d := os.Getenv("BROWSER_CONTROL_SCRIPTS_DIR"); d != "" {
		return d
	}
	dotfiles := os.Getenv("DOTFILES_DIR")
	if dotfiles == "" {
		home, _ := os.UserHomeDir()
		dotfiles = filepath.Join(home, "dotfiles")
	}
	return filepath.Join(dotfiles, "user-scripts")
}

var nonAlphaNum = regexp.MustCompile(`[^a-z0-9]+`)

// scriptFileName transforms a script name into a filesystem-friendly filename.
// "My Cool Script!" -> "my-cool-script.user.js"
func scriptFileName(name string) string {
	s := strings.ToLower(strings.TrimSpace(name))
	s = nonAlphaNum.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "unnamed"
	}
	return s + ".user.js"
}

var metaNameRe = regexp.MustCompile(`(?m)^//\s*@name\s+(.+)$`)

// parseScriptName extracts the @name from a userscript's metadata block.
func parseScriptName(code []byte) string {
	m := metaNameRe.FindSubmatch(code)
	if m != nil {
		return strings.TrimSpace(string(m[1]))
	}
	return ""
}

// saveScriptToArchive writes the script source to the archive directory.
// Skips the write if the file already contains identical content, so the
// mtime is not bumped unnecessarily (coding agents use mtime to detect
// external edits and will back off if the file appears touched).
func saveScriptToArchive(code []byte, name string) (string, error) {
	dir := scriptArchiveDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("creating script archive dir: %w", err)
	}
	filename := scriptFileName(name)
	path := filepath.Join(dir, filename)
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, code) {
		return path, nil
	}
	if err := os.WriteFile(path, code, 0o644); err != nil {
		return "", fmt.Errorf("writing script archive: %w", err)
	}
	return path, nil
}

// archiveScript saves script source to the dotfiles archive directory.
// Logs a warning to stderr on failure, never returns an error.
func archiveScript(code []byte) {
	name := parseScriptName(code)
	if name == "" {
		return
	}
	if path, err := saveScriptToArchive(code, name); err != nil {
		fmt.Fprintf(os.Stderr, "warning: %v\n", err)
	} else {
		fmt.Fprintf(os.Stderr, "saved: %s\n", path)
	}
}

var scriptCmd = &cobra.Command{
	Use:   "script",
	Short: "Manage userscripts",
}

var scriptListCmd = &cobra.Command{
	Use:   "list",
	Short: "List installed userscripts",
	RunE: func(cmd *cobra.Command, args []string) error {
		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		filter := map[string]any{}
		if v, _ := cmd.Flags().GetBool("enabled"); v {
			filter["enabled"] = true
		}
		if v, _ := cmd.Flags().GetBool("disabled"); v {
			filter["enabled"] = false
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd:  "script.list",
			Args: map[string]any{"filter": filter},
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data []struct {
				UUID    string `json:"uuid"`
				Name    string `json:"name"`
				Enabled bool   `json:"enabled"`
				Version string `json:"version"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		for _, s := range result.Data {
			status := "off"
			if s.Enabled {
				status = " on"
			}
			fmt.Printf("  %-36s  [%s]  %-40s  v%s\n", s.UUID, status, s.Name, s.Version)
		}
		return nil
	},
}

var scriptGetCmd = &cobra.Command{
	Use:   "get <uuid>",
	Short: "Get userscript details",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		uuid := args[0]

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd:  "script.get",
			Args: map[string]any{"uuid": uuid},
		})
		if err != nil {
			return err
		}

		showSource, _ := cmd.Flags().GetBool("source")
		if flagJSON || showSource {
			fmt.Println(string(resp))
			return nil
		}

		// pretty-print
		var pretty json.RawMessage = resp
		out, _ := json.MarshalIndent(pretty, "", "  ")
		fmt.Println(string(out))
		return nil
	},
}

var scriptCreateCmd = &cobra.Command{
	Use:   "create <file.user.js>",
	Short: "Install a new userscript from file",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		code, err := os.ReadFile(args[0])
		if err != nil {
			return fmt.Errorf("reading file: %w", err)
		}

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd: "script.create",
			Args: map[string]any{
				"code":    string(code),
				"enabled": true,
			},
		})
		if err != nil {
			return err
		}

		fmt.Println(string(resp))

		// save to archive directory
		noSave, _ := cmd.Flags().GetBool("no-save")
		if !noSave {
			archiveScript(code)
		}
		return nil
	},
}

var scriptUpdateCmd = &cobra.Command{
	Use:   "update <uuid> <file.user.js>",
	Short: "Update an existing userscript from file",
	Args:  cobra.ExactArgs(2),
	RunE: func(cmd *cobra.Command, args []string) error {
		uuid := args[0]

		code, err := os.ReadFile(args[1])
		if err != nil {
			return fmt.Errorf("reading file: %w", err)
		}

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd: "script.update",
			Args: map[string]any{
				"uuid": uuid,
				"code": string(code),
			},
		})
		if err != nil {
			return err
		}

		fmt.Println(string(resp))

		// save to archive directory
		noSave, _ := cmd.Flags().GetBool("no-save")
		if !noSave {
			archiveScript(code)
		}
		return nil
	},
}

var scriptDeleteCmd = &cobra.Command{
	Use:   "delete <uuid>",
	Short: "Delete a userscript",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		uuid := args[0]

		confirm, _ := cmd.Flags().GetBool("confirm")
		if !confirm {
			return fmt.Errorf("refusing to delete script %s without --confirm", uuid)
		}

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd:  "script.delete",
			Args: map[string]any{"uuid": uuid},
		})
		if err != nil {
			return err
		}

		fmt.Println(string(resp))
		return nil
	},
}

var scriptToggleCmd = &cobra.Command{
	Use:   "toggle <uuid>",
	Short: "Toggle a userscript on/off",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		uuid := args[0]

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd:  "script.toggle",
			Args: map[string]any{"uuid": uuid},
		})
		if err != nil {
			return err
		}

		fmt.Println(string(resp))
		return nil
	},
}

var scriptPushCmd = &cobra.Command{
	Use:   "push <file.user.js>",
	Short: "Create-or-update a userscript (matched by @name + @namespace)",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		code, err := os.ReadFile(args[0])
		if err != nil {
			return fmt.Errorf("reading file: %w", err)
		}

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd: "script.push",
			Args: map[string]any{
				"code":    string(code),
				"enabled": true,
			},
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
		} else {
			apiResp, err := parsePushResponse(resp)
			if err != nil {
				fmt.Println(string(resp))
			} else {
				result := pushResult{
					Script:  args[0],
					Browser: target,
					UUID:    apiResp.Data.UUID,
					IsNew:   apiResp.Data.IsNew,
					Errors:  len(apiResp.Data.Errors),
					Success: true,
				}
				printPushStatus(filepath.Base(args[0]), result)
				stats := collectPushStats([]pushResult{result})
				fmt.Fprintf(os.Stderr, "Stats: created=%d updated=%d\n", stats.Created, stats.Updated)
			}
		}

		// save to archive directory
		noSave, _ := cmd.Flags().GetBool("no-save")
		if !noSave {
			archiveScript(code)
		}
		return nil
	},
}

// pushResult holds the result of pushing a single script
type pushResult struct {
	Script  string `json:"script"`
	Browser string `json:"browser"`
	UUID    string `json:"uuid,omitempty"`
	IsNew   bool   `json:"is_new,omitempty"`
	Errors  int    `json:"errors,omitempty"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
}

type pushAPIResponse struct {
	Data struct {
		UUID   string `json:"uuid"`
		IsNew  bool   `json:"isNew"`
		Errors []any  `json:"errors"`
	} `json:"data"`
}

type pushStats struct {
	Created   int
	Updated   int
	Completed int
	Failed    int
}

func parsePushResponse(resp []byte) (*pushAPIResponse, error) {
	var apiResp pushAPIResponse
	if err := json.Unmarshal(resp, &apiResp); err != nil {
		return nil, err
	}
	return &apiResp, nil
}

func collectPushStats(results []pushResult) pushStats {
	var stats pushStats
	for _, result := range results {
		if !result.Success {
			stats.Failed++
			continue
		}
		stats.Completed++
		if result.IsNew {
			stats.Created++
		} else {
			stats.Updated++
		}
	}
	return stats
}

func printPushStatus(scriptName string, result pushResult) {
	action := "updated"
	if result.IsNew {
		action = "created"
	}
	fmt.Fprintf(os.Stderr, "%s -> %s (uuid: %s)\n", scriptName, action, result.UUID)
	if result.Errors > 0 {
		fmt.Fprintf(os.Stderr, "  script has %d error(s)\n", result.Errors)
	}
}

// collectScripts finds all .user.js files in path (file or directory)
func collectScripts(path string, recursive bool) ([]string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, fmt.Errorf("path not found: %w", err)
	}

	if !info.IsDir() {
		// single file
		if !strings.HasSuffix(path, ".user.js") {
			return nil, fmt.Errorf("file must have .user.js extension: %s", path)
		}
		return []string{path}, nil
	}

	// directory - find all .user.js files
	var scripts []string
	if recursive {
		err = filepath.WalkDir(path, func(walkPath string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				return nil
			}
			if strings.HasSuffix(d.Name(), ".user.js") {
				scripts = append(scripts, walkPath)
			}
			return nil
		})
		if err != nil {
			return nil, fmt.Errorf("walking directory: %w", err)
		}
	} else {
		entries, err := os.ReadDir(path)
		if err != nil {
			return nil, fmt.Errorf("reading directory: %w", err)
		}

		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			if strings.HasSuffix(entry.Name(), ".user.js") {
				scripts = append(scripts, filepath.Join(path, entry.Name()))
			}
		}
	}

	if len(scripts) == 0 {
		if recursive {
			return nil, fmt.Errorf("no .user.js files found recursively in: %s", path)
		}
		return nil, fmt.Errorf("no .user.js files found in: %s", path)
	}

	return scripts, nil
}

// pushScriptToBrowser pushes a single script to a single browser
func pushScriptToBrowser(c *cli.Client, script, browser string, quiet bool) pushResult {
	result := pushResult{
		Script:  script,
		Browser: browser,
		Success: false,
	}

	code, err := os.ReadFile(script)
	if err != nil {
		result.Error = fmt.Sprintf("reading file: %v", err)
		return result
	}

	resp, err := c.Request(browser, cli.ExtCommand{
		Cmd: "script.push",
		Args: map[string]any{
			"code":    string(code),
			"enabled": true,
		},
	})
	if err != nil {
		result.Error = err.Error()
		return result
	}

	apiResp, err := parsePushResponse(resp)
	if err != nil {
		result.Error = fmt.Sprintf("parsing response: %v", err)
		return result
	}

	result.Success = true
	result.UUID = apiResp.Data.UUID
	result.IsNew = apiResp.Data.IsNew
	result.Errors = len(apiResp.Data.Errors)

	if !quiet {
		printPushStatus(filepath.Base(script), result)
	}

	return result
}

var scriptPushAllCmd = &cobra.Command{
	Use:   "push-all <path>",
	Short: "Push all userscripts from directory to browser(s)",
	Long: `Push all .user.js files from an explicit directory or file path to one or more browsers.

Examples:
  browser-control script push-all ~/my-scripts         # push from custom dir
  browser-control script push-all my-script.user.js    # push single file
  browser-control script push-all ~/my-scripts --all-browsers
  browser-control script push-all ~/my-scripts --parallel
  browser-control script push-all ~/my-scripts --recursive
  browser-control script push-all ~/my-scripts --dry-run`,
	Args: cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		targetPath := args[0]

		// expand tilde
		if strings.HasPrefix(targetPath, "~/") {
			home, _ := os.UserHomeDir()
			targetPath = filepath.Join(home, targetPath[2:])
		}

		recursive, _ := cmd.Flags().GetBool("recursive")

		// collect scripts
		scripts, err := collectScripts(targetPath, recursive)
		if err != nil {
			return err
		}

		quiet, _ := cmd.Flags().GetBool("quiet")
		dryRun, _ := cmd.Flags().GetBool("dry-run")

		if !quiet {
			fmt.Fprintf(os.Stderr, "Collecting scripts from: %s\n", targetPath)
			fmt.Fprintf(os.Stderr, "Found %d userscript(s)\n", len(scripts))
		}

		if dryRun {
			if !quiet {
				fmt.Fprintf(os.Stderr, "DRY RUN MODE - no changes will be made\n\n")
			}
			for _, script := range scripts {
				fmt.Println(filepath.Base(script))
			}
			return nil
		}

		// connect
		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		// determine target browsers
		allBrowsers, _ := cmd.Flags().GetBool("all-browsers")
		parallel, _ := cmd.Flags().GetBool("parallel")

		var browsers []string
		if allBrowsers || parallel {
			browsers = browserPeers(c.Peers())
			if len(browsers) == 0 {
				return fmt.Errorf("no browsers connected")
			}
			if !quiet {
				fmt.Fprintf(os.Stderr, "Found %d connected browser(s): %v\n", len(browsers), browsers)
			}
		} else {
			// single browser (auto-select or --browser flag)
			target, err := resolveBrowser(c.Peers())
			if err != nil {
				return err
			}
			browsers = []string{target}
		}

		// push scripts
		var results []pushResult
		var mu sync.Mutex

		if parallel && len(browsers) > 1 {
			// parallel mode: push to each browser concurrently
			var wg sync.WaitGroup
			for _, browser := range browsers {
				wg.Add(1)
				go func(b string) {
					defer wg.Done()
					browserClient, err := cli.Connect()
					if err != nil {
						mu.Lock()
						for _, script := range scripts {
							results = append(results, pushResult{
								Script:  script,
								Browser: b,
								Success: false,
								Error:   fmt.Sprintf("connecting client: %v", err),
							})
						}
						mu.Unlock()
						return
					}
					defer browserClient.Close()

					for _, script := range scripts {
						result := pushScriptToBrowser(browserClient, script, b, quiet)
						mu.Lock()
						results = append(results, result)
						mu.Unlock()
					}
				}(browser)
			}
			if !quiet {
				fmt.Fprintf(os.Stderr, "Pushing scripts in parallel...\n")
			}
			wg.Wait()
		} else {
			// sequential mode
			for _, browser := range browsers {
				if len(browsers) > 1 && !quiet {
					fmt.Fprintf(os.Stderr, "\n[%s]\n", browser)
				}
				for _, script := range scripts {
					result := pushScriptToBrowser(c, script, browser, quiet)
					results = append(results, result)
					if !result.Success {
						if !quiet {
							fmt.Fprintf(os.Stderr, "%s -> failed: %s\n", filepath.Base(script), result.Error)
						}
					}
				}
			}
		}

		stats := collectPushStats(results)

		// output
		if flagJSON {
			out, _ := json.MarshalIndent(results, "", "  ")
			fmt.Println(string(out))
		} else if !quiet {
			total := len(scripts) * len(browsers)
			fmt.Fprintf(os.Stderr, "\n----------------------------------\n")
			fmt.Fprintf(os.Stderr, "Summary:\n")
			fmt.Fprintf(os.Stderr, "  Scripts: %d\n", len(scripts))
			fmt.Fprintf(os.Stderr, "  Browsers: %d\n", len(browsers))
			fmt.Fprintf(os.Stderr, "  Operations: %d\n", total)
			fmt.Fprintf(os.Stderr, "Completed: %d\n", stats.Completed)
			fmt.Fprintf(os.Stderr, "  Created: %d\n", stats.Created)
			fmt.Fprintf(os.Stderr, "  Updated: %d\n", stats.Updated)
			if stats.Failed > 0 {
				fmt.Fprintf(os.Stderr, "Failed: %d\n", stats.Failed)
			}
			fmt.Fprintf(os.Stderr, "----------------------------------\n")
			if stats.Failed == 0 {
				fmt.Fprintf(os.Stderr, "All scripts pushed successfully!\n")
			}
		}

		if stats.Failed > 0 {
			return fmt.Errorf("%d operation(s) failed", stats.Failed)
		}
		return nil
	},
}

var scriptWatchCmd = &cobra.Command{
	Use:   "watch [path]",
	Short: "Watch directory and auto-push userscript changes",
	Long: `Watch a directory for .user.js file changes and automatically push updates.

If no path is provided, uses $BROWSER_CONTROL_SCRIPTS_DIR,
then $DOTFILES_DIR/user-scripts, then ~/dotfiles/user-scripts.

Examples:
  browser-control script watch                    # watch default dir
  browser-control script watch ~/my-scripts       # watch custom dir
  browser-control script watch --initial-push     # push all on start, then watch
  browser-control script watch --debounce 2       # custom debounce delay`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// determine path
		targetPath := scriptArchiveDir()
		if len(args) > 0 {
			targetPath = args[0]
		}

		// expand tilde
		if strings.HasPrefix(targetPath, "~/") {
			home, _ := os.UserHomeDir()
			targetPath = filepath.Join(home, targetPath[2:])
		}

		// verify path exists and is directory
		info, err := os.Stat(targetPath)
		if err != nil {
			return fmt.Errorf("path not found: %w", err)
		}
		if !info.IsDir() {
			return fmt.Errorf("path must be a directory: %s", targetPath)
		}

		debounce, _ := cmd.Flags().GetInt("debounce")
		initialPush, _ := cmd.Flags().GetBool("initial-push")

		// initial push if requested
		if initialPush {
			fmt.Fprintf(os.Stderr, "Performing initial push...\n")
			pushAllCmd := scriptPushAllCmd
			if err := pushAllCmd.RunE(pushAllCmd, []string{targetPath}); err != nil {
				return fmt.Errorf("initial push failed: %w", err)
			}
			fmt.Fprintf(os.Stderr, "\n")
		}

		// setup file watcher
		watcher, err := fsnotify.NewWatcher()
		if err != nil {
			return fmt.Errorf("creating watcher: %w", err)
		}
		defer watcher.Close()

		if err := watcher.Add(targetPath); err != nil {
			return fmt.Errorf("watching directory: %w", err)
		}

		fmt.Fprintf(os.Stderr, "Watching for changes in: %s\n", targetPath)
		fmt.Fprintf(os.Stderr, "Press Ctrl+C to stop\n\n")

		// process file change
		processFile := func(path string) {
			// push the file
			fmt.Fprintf(os.Stderr, "Pushing %s...\n", filepath.Base(path))

			c, err := cli.Connect()
			if err != nil {
				fmt.Fprintf(os.Stderr, "Connection failed: %v\n", err)
				return
			}
			defer c.Close()

			target, err := resolveBrowser(c.Peers())
			if err != nil {
				fmt.Fprintf(os.Stderr, "Browser resolution failed: %v\n", err)
				return
			}

			result := pushScriptToBrowser(c, path, target, false)
			if !result.Success {
				fmt.Fprintf(os.Stderr, "Push failed: %s\n", result.Error)
			}
		}

		// 每个文件在最后一次编辑后推送，单次推送完成后再处理后续任务
		pending := make(map[string]time.Time)
		timer := time.NewTimer(time.Hour)
		timer.Stop()
		defer timer.Stop()
		resetTimer := func() {
			timer.Stop()
			var earliest time.Time
			for _, deadline := range pending {
				if earliest.IsZero() || deadline.Before(earliest) {
					earliest = deadline
				}
			}
			if !earliest.IsZero() {
				timer.Reset(time.Until(earliest))
			}
		}

		// watch loop
		for {
			select {
			case <-cmd.Context().Done():
				return cmd.Context().Err()
			case <-timer.C:
				now := time.Now()
				for path, deadline := range pending {
					if !deadline.After(now) {
						delete(pending, path)
						processFile(path)
					}
				}
				resetTimer()
			case event, ok := <-watcher.Events:
				if !ok {
					return nil
				}

				// only process .user.js files
				if !strings.HasSuffix(event.Name, ".user.js") {
					continue
				}

				// process write and create events
				if event.Op&fsnotify.Write == fsnotify.Write ||
					event.Op&fsnotify.Create == fsnotify.Create {
					pending[event.Name] = time.Now().Add(time.Duration(debounce) * time.Second)
					resetTimer()
				}

			case err, ok := <-watcher.Errors:
				if !ok {
					return nil
				}
				fmt.Fprintf(os.Stderr, "Watcher error: %v\n", err)
			}
		}
	},
}

func init() {
	scriptListCmd.Flags().Bool("enabled", false, "show only enabled scripts")
	scriptListCmd.Flags().Bool("disabled", false, "show only disabled scripts")

	scriptGetCmd.Flags().Bool("source", false, "include source code in output")

	scriptCreateCmd.Flags().Bool("no-save", false, "skip saving script to archive directory")
	scriptUpdateCmd.Flags().Bool("no-save", false, "skip saving script to archive directory")

	scriptDeleteCmd.Flags().Bool("confirm", false, "confirm deletion (required)")

	scriptPushCmd.Flags().Bool("no-save", false, "skip saving script to archive directory")

	scriptPushAllCmd.Flags().Bool("all-browsers", false, "push to all connected browsers")
	scriptPushAllCmd.Flags().Bool("parallel", false, "push to browsers in parallel")
	scriptPushAllCmd.Flags().BoolP("recursive", "r", false, "search directories recursively for .user.js files")
	scriptPushAllCmd.Flags().Bool("dry-run", false, "show what would be pushed without doing it")
	scriptPushAllCmd.Flags().Bool("quiet", false, "minimal output")

	scriptWatchCmd.Flags().Bool("initial-push", false, "push all scripts on startup")
	scriptWatchCmd.Flags().Int("debounce", 1, "debounce delay in seconds")

	scriptCmd.AddCommand(
		scriptListCmd,
		scriptGetCmd,
		scriptCreateCmd,
		scriptUpdateCmd,
		scriptDeleteCmd,
		scriptToggleCmd,
		scriptPushCmd,
		scriptPushAllCmd,
		scriptWatchCmd,
	)
	rootCmd.AddCommand(scriptCmd)
}
