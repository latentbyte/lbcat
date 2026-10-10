package cmd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/jpeg"
	"image/png"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
	"golang.org/x/image/draw"
)

var base64Std = base64.StdEncoding

var pageCmd = &cobra.Command{
	Use:   "page",
	Short: "Interact with page content",
}

var pageContentCmd = &cobra.Command{
	Use:   "content <tab-id>",
	Short: "Get page DOM content",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}

		selector, _ := cmd.Flags().GetString("selector")
		format, _ := cmd.Flags().GetString("format")
		maxChars, _ := cmd.Flags().GetInt("max-chars")

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd: "page.content",
			Args: map[string]any{
				"tabId":    tabID,
				"selector": selector,
				"format":   format,
				"maxChars": maxChars,
			},
		})
		if err != nil {
			return err
		}

		out := cmd.OutOrStdout()
		if flagJSON {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}

		var result struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}
		_, err = fmt.Fprint(out, result.Data)
		return err
	},
}

var pageExecCmd = &cobra.Command{
	Use:   "exec <tab-id> [code]",
	Short: "Execute JavaScript in a tab",
	Long: `Execute JavaScript in the page's MAIN world.
Provide code inline or use -f to read from a file.

A single expression returns its value and may use await ({a: 1} is an object,
not a block). Statements return the last expression's value; top-level return
and await also work. Promises inside a returned object or array are awaited.
undefined becomes null. DOM nodes, functions, and circular values fail with
RESULT_NOT_SERIALIZABLE; exceptions fail with SCRIPT_ERROR. When page CSP
forbids eval, the code is injected as source through userScripts.execute
(Chrome 135+) and statements then need return for a value; without that API
it fails with CSP_BLOCKED. --max-chars truncates long results and reports
truncated/totalLength.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}

		var code string
		file, _ := cmd.Flags().GetString("file")
		world, _ := cmd.Flags().GetString("world")
		maxChars, _ := cmd.Flags().GetInt("max-chars")

		if file != "" {
			data, err := os.ReadFile(file)
			if err != nil {
				return fmt.Errorf("reading file: %w", err)
			}
			code = string(data)
		} else if len(args) > 1 {
			code = args[1]
		} else {
			return fmt.Errorf("provide code as argument or use -f <file>")
		}

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		resp, err := c.RequestWithTimeout(target, cli.ExtCommand{
			Cmd: "page.exec",
			Args: map[string]any{
				"tabId":     tabID,
				"code":      code,
				"world":     world,
				"timeoutMs": int(pageExecTimeout / time.Millisecond),
				"maxChars":  maxChars,
			},
		}, pageExecTimeout+2*time.Second)
		if err != nil {
			return err
		}

		out := cmd.OutOrStdout()
		if flagJSON {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}

		var result struct {
			Data any `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}

		// pretty-print the result
		pretty, _ := json.MarshalIndent(result.Data, "", "  ")
		_, err = fmt.Fprintln(out, string(pretty))
		return err
	},
}

var pageReloadCmd = &cobra.Command{
	Use:   "reload <tab-id>",
	Short: "Reload a tab",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}

		bypassCache, _ := cmd.Flags().GetBool("bypass-cache")

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		request, timeout, err := waitArgs(cmd, map[string]any{"tabId": tabID, "bypassCache": bypassCache})
		if err != nil {
			return err
		}
		request["timeoutMs"] = int(timeout / time.Millisecond)
		resp, err := c.RequestWithTimeout(target, cli.ExtCommand{Cmd: "page.reload", Args: request},
			timeout+pageRequestMargin)
		if err != nil {
			return err
		}

		if flagJSON {
			_, err := fmt.Fprintln(cmd.OutOrStdout(), string(resp))
			return err
		}

		_, err = fmt.Fprintf(cmd.OutOrStdout(), "reloaded tab %d\n", tabID)
		return err
	},
}

var pageExecTimeout time.Duration

var pageScreenshotCmd = &cobra.Command{
	Use:   "screenshot <tab-id>",
	Short: "Capture a screenshot of a tab",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}

		selector, _ := cmd.Flags().GetString("selector")
		format, _ := cmd.Flags().GetString("format")
		quality, _ := cmd.Flags().GetInt("quality")
		fullPage, _ := cmd.Flags().GetBool("full-page")
		output, _ := cmd.Flags().GetString("output")
		maxPixels, _ := cmd.Flags().GetInt("max-pixels")
		focusOnError, _ := cmd.Flags().GetBool("focus-on-error")
		foreground, _ := cmd.Flags().GetBool("foreground")
		if focusOnError && !foreground {
			return fmt.Errorf("--focus-on-error requires --foreground")
		}
		timeout, _ := cmd.Flags().GetDuration("timeout")

		c, err := connectScoped()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		cmdArgs := map[string]any{
			"tabId":           tabID,
			"format":          format,
			"quality":         quality,
			"fullPage":        fullPage,
			"allowForeground": foreground,
		}
		if selector != "" {
			cmdArgs["selector"] = selector
		}

		resp, err := c.RequestWithTimeout(target, cli.ExtCommand{
			Cmd:  "page.screenshot",
			Args: cmdArgs,
		}, timeout)
		if extErr, ok := parseExtensionError(resp); ok {
			if focusOnError {
				return handleScreenshotExtensionError(c, target, tabID, extErr)
			}
			return fmt.Errorf("page screenshot failed: %w", &extErr)
		}
		if err != nil {
			return err
		}

		out := cmd.OutOrStdout()
		// --json without --output is an explicit request for the raw image data
		if flagJSON && output == "" {
			_, err := fmt.Fprintln(out, string(resp))
			return err
		}

		var result struct {
			Data struct {
				DataURL string `json:"dataUrl"`
				Width   int    `json:"width"`
				Height  int    `json:"height"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			return fmt.Errorf("decoding screenshot response: %w", err)
		}

		if output == "" {
			_, err := fmt.Fprintf(out, "screenshot captured (%dx%d), use --output to save to file\n",
				result.Data.Width, result.Data.Height)
			return err
		}

		// strip the data:image/...;base64, prefix
		_, encoded, found := strings.Cut(result.Data.DataURL, ",")
		if !found || encoded == "" {
			return fmt.Errorf("unexpected data URL format")
		}
		decoded, err := base64Decode(encoded)
		if err != nil {
			return fmt.Errorf("decoding screenshot data: %w", err)
		}
		decoded, outWidth, outHeight, err := resizeImage(decoded, format, quality, maxPixels)
		if err != nil {
			return fmt.Errorf("resizing screenshot: %w", err)
		}
		if err := os.WriteFile(output, decoded, 0o644); err != nil {
			return fmt.Errorf("writing screenshot: %w", err)
		}
		if flagJSON {
			data, err := json.Marshal(map[string]any{"cmd": "page.screenshot", "data": map[string]any{
				"path": output, "width": outWidth, "height": outHeight, "bytes": len(decoded),
			}})
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(out, string(data))
			return err
		}
		_, err = fmt.Fprintf(out, "screenshot saved to %s (%dx%d bitmap pixels)\n", output, outWidth, outHeight)
		return err
	},
}

type extensionError = cli.CommandError

type browserRequestClient interface {
	Request(target string, payload any) (json.RawMessage, error)
}

type focusedTab struct {
	TabID    int
	WindowID int
}

// parseExtensionError detects browser-side command errors wrapped in normal responses.
func parseExtensionError(resp json.RawMessage) (extensionError, bool) {
	var result struct {
		Error *cli.CommandError `json:"error"`
	}
	if err := json.Unmarshal(resp, &result); err != nil || result.Error == nil {
		return extensionError{}, false
	}
	return *result.Error, true
}

func formatExtensionError(extErr extensionError) string {
	if extErr.Code == "" {
		return extErr.Message
	}
	if extErr.Message == "" {
		return extErr.Code
	}
	return fmt.Sprintf("%s: %s", extErr.Code, extErr.Message)
}

func shouldFocusForCallerCapture(extErr extensionError) bool {
	msg := strings.ToLower(extErr.Code + " " + extErr.Message)
	return strings.Contains(msg, "activetab") ||
		(strings.Contains(msg, "permission") && strings.Contains(msg, "capture")) ||
		strings.Contains(msg, "capturevisibletab")
}

func handleScreenshotExtensionError(c browserRequestClient, target string, tabID int, extErr extensionError) error {
	baseErr := formatExtensionError(extErr)
	if !shouldFocusForCallerCapture(extErr) {
		return fmt.Errorf("page screenshot failed: %s", baseErr)
	}

	focused, err := focusTabForCallerCapture(c, target, tabID)
	if err != nil {
		return fmt.Errorf("page screenshot failed: %s; also failed to focus tab for caller capture: %w", baseErr, err)
	}
	return fmt.Errorf("page screenshot failed: %s; focused tab %d in window %d and browser reports it active, caller may run OS-level capture", baseErr, focused.TabID, focused.WindowID)
}

func focusTabForCallerCapture(c browserRequestClient, target string, tabID int) (focusedTab, error) {
	focusResp, err := c.Request(target, cli.ExtCommand{
		Cmd:  "tabs.focus",
		Args: map[string]any{"tabId": tabID, "allowFocus": true},
	})
	if err != nil {
		return focusedTab{}, err
	}
	if extErr, ok := parseExtensionError(focusResp); ok {
		return focusedTab{}, fmt.Errorf("tabs.focus failed: %s", formatExtensionError(extErr))
	}

	var focusResult struct {
		Data struct {
			TabID    int `json:"tabId"`
			WindowID int `json:"windowId"`
		} `json:"data"`
	}
	if err := json.Unmarshal(focusResp, &focusResult); err != nil {
		return focusedTab{}, fmt.Errorf("decoding tabs.focus response: %w", err)
	}

	getResp, err := c.Request(target, cli.ExtCommand{
		Cmd:  "tabs.get",
		Args: map[string]any{"tabId": tabID},
	})
	if err != nil {
		return focusedTab{}, err
	}
	if extErr, ok := parseExtensionError(getResp); ok {
		return focusedTab{}, fmt.Errorf("tabs.get failed: %s", formatExtensionError(extErr))
	}

	var getResult struct {
		Data struct {
			ID       int  `json:"id"`
			WindowID int  `json:"windowId"`
			Active   bool `json:"active"`
		} `json:"data"`
	}
	if err := json.Unmarshal(getResp, &getResult); err != nil {
		return focusedTab{}, fmt.Errorf("decoding tabs.get response: %w", err)
	}
	if getResult.Data.ID != tabID {
		return focusedTab{}, fmt.Errorf("tabs.get returned tab %d, want %d", getResult.Data.ID, tabID)
	}
	if !getResult.Data.Active {
		return focusedTab{}, fmt.Errorf("tab %d is not active after focus", tabID)
	}
	windowID := focusResult.Data.WindowID
	if windowID == 0 {
		windowID = getResult.Data.WindowID
	}
	return focusedTab{TabID: tabID, WindowID: windowID}, nil
}

// base64Decode decodes standard base64 (with padding).
func base64Decode(s string) ([]byte, error) {
	// use encoding/base64
	return base64Std.DecodeString(s)
}

// resizeImage scales imageData down so total pixels stay within maxPixels, preserving aspect ratio.
// format is "png" or "jpeg"; quality is used only for jpeg output.
func resizeImage(imageData []byte, format string, quality, maxPixels int) ([]byte, int, int, error) {
	config, _, err := image.DecodeConfig(bytes.NewReader(imageData))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("decoding image dimensions: %w", err)
	}
	origWidth, origHeight := config.Width, config.Height
	if maxPixels <= 0 || float64(origWidth)*float64(origHeight) <= float64(maxPixels) {
		return imageData, origWidth, origHeight, nil
	}
	src, _, err := image.Decode(bytes.NewReader(imageData))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("decoding image: %w", err)
	}
	// scale = sqrt(maxPixels / totalPixels), applied to both dimensions
	scale := math.Sqrt(float64(maxPixels) / (float64(origWidth) * float64(origHeight)))
	newWidth := min(maxPixels, max(1, int(float64(origWidth)*scale)))
	newHeight := min(maxPixels/newWidth, max(1, int(float64(origHeight)*scale)))
	dst := image.NewRGBA(image.Rect(0, 0, newWidth, newHeight))
	draw.BiLinear.Scale(dst, dst.Bounds(), src, src.Bounds(), draw.Over, nil)
	var buf bytes.Buffer
	if format == "jpeg" {
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: quality}); err != nil {
			return nil, 0, 0, fmt.Errorf("encoding jpeg: %w", err)
		}
	} else {
		if err := png.Encode(&buf, dst); err != nil {
			return nil, 0, 0, fmt.Errorf("encoding png: %w", err)
		}
	}
	return buf.Bytes(), newWidth, newHeight, nil
}

func init() {
	pageContentCmd.Flags().String("selector", "body", "CSS selector for content extraction")
	pageContentCmd.Flags().String("format", "text", "output format: text, markdown (links, headings, lists, tables), html")
	pageContentCmd.Flags().Int("max-chars", 0, "truncate to this many characters and append a [truncated: N of M] note (0 = no limit)")

	pageExecCmd.Flags().StringP("file", "f", "", "read JavaScript from file")
	pageExecCmd.Flags().String("world", "MAIN", "execution world: MAIN (dynamic code requires page context)")
	pageExecCmd.Flags().Int("max-chars", 0, "truncate the result to this many characters (0 = no limit)")
	pageExecCmd.Flags().DurationVar(&pageExecTimeout, "timeout", 45*time.Second,
		"max time to wait for script execution response")

	pageReloadCmd.Flags().Bool("bypass-cache", false, "bypass browser cache on reload")

	pageScreenshotCmd.Flags().String("selector", "", "CSS selector for element screenshot")
	pageScreenshotCmd.Flags().String("format", "png", "image format: png, jpeg")
	pageScreenshotCmd.Flags().Int("quality", 80, "JPEG quality (0-100, ignored for PNG)")
	pageScreenshotCmd.Flags().Bool("full-page", false, "capture full scrollable page")
	pageScreenshotCmd.Flags().Bool("foreground", false, "allow visible-tab screenshot fallback to activate this tab")
	pageScreenshotCmd.Flags().Bool("focus-on-error", false, "focus tab for caller capture if screenshot permission fails")
	pageScreenshotCmd.Flags().Duration("timeout", 2*time.Minute, "max time to wait for screenshot response")
	pageScreenshotCmd.Flags().StringP("output", "o", "", "save screenshot to file")
	pageScreenshotCmd.Flags().Int("max-pixels", 1_000_000, "resize screenshot if total pixels exceed this limit (0 to disable)")

	pageCmd.AddCommand(pageContentCmd, pageExecCmd, pageReloadCmd, pageScreenshotCmd)
	rootCmd.AddCommand(pageCmd)
}
