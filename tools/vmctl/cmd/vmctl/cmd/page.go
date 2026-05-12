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
	"time"

	"github.com/scriptscat/scriptcat/tools/vmctl/internal/cli"
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
			Cmd: "page.content",
			Args: map[string]any{
				"tabId":    tabID,
				"selector": selector,
				"format":   format,
			},
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data string `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}
		fmt.Print(result.Data)
		return nil
	},
}

var pageExecCmd = &cobra.Command{
	Use:   "exec <tab-id> [code]",
	Short: "Execute JavaScript in a tab",
	Long: `Execute arbitrary JavaScript in the context of a browser tab.
Provide code inline or use -f to read from a file.`,
	Args: cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := strconv.Atoi(args[0])
		if err != nil {
			return fmt.Errorf("invalid tab ID: %w", err)
		}

		var code string
		file, _ := cmd.Flags().GetString("file")
		world, _ := cmd.Flags().GetString("world")

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

		c, err := cli.Connect()
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
			},
		}, pageExecTimeout+2*time.Second)
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data any `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		// pretty-print the result
		out, _ := json.MarshalIndent(result.Data, "", "  ")
		fmt.Println(string(out))
		return nil
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
			Cmd: "page.reload",
			Args: map[string]any{
				"tabId":       tabID,
				"bypassCache": bypassCache,
			},
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		fmt.Printf("reloaded tab %d\n", tabID)
		_ = resp
		return nil
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

		c, err := cli.Connect()
		if err != nil {
			return err
		}
		defer c.Close()

		target, err := resolveBrowser(c.Peers())
		if err != nil {
			return err
		}

		cmdArgs := map[string]any{
			"tabId":    tabID,
			"format":   format,
			"quality":  quality,
			"fullPage": fullPage,
		}
		if selector != "" {
			cmdArgs["selector"] = selector
		}

		resp, err := c.Request(target, cli.ExtCommand{
			Cmd:  "page.screenshot",
			Args: cmdArgs,
		})
		if err != nil {
			return err
		}

		if flagJSON {
			fmt.Println(string(resp))
			return nil
		}

		var result struct {
			Data struct {
				DataURL string `json:"dataUrl"`
				Width   int    `json:"width"`
				Height  int    `json:"height"`
			} `json:"data"`
		}
		if err := json.Unmarshal(resp, &result); err != nil {
			fmt.Println(string(resp))
			return nil
		}

		if output != "" {
			// decode base64 data URL and write to file
			data := result.Data.DataURL
			// strip data:image/...;base64, prefix
			idx := 0
			for i := range data {
				if data[i] == ',' {
					idx = i + 1
					break
				}
			}
			if idx > 0 && idx < len(data) {
				decoded, err := base64Decode(data[idx:])
				if err != nil {
					return fmt.Errorf("decoding screenshot data: %w", err)
				}
				outWidth := result.Data.Width
				outHeight := result.Data.Height
				if maxPixels > 0 && outWidth*outHeight > maxPixels {
					decoded, outWidth, outHeight, err = resizeImage(decoded, format, quality, maxPixels, outWidth, outHeight)
					if err != nil {
						return fmt.Errorf("resizing screenshot: %w", err)
					}
				}
				if err := os.WriteFile(output, decoded, 0o644); err != nil {
					return fmt.Errorf("writing screenshot: %w", err)
				}
				fmt.Printf("screenshot saved to %s (%dx%d)\n", output, outWidth, outHeight)
			} else {
				return fmt.Errorf("unexpected data URL format")
			}
		} else {
			fmt.Printf("screenshot captured (%dx%d), use --output to save to file\n",
				result.Data.Width, result.Data.Height)
		}
		return nil
	},
}

// base64Decode decodes standard base64 (with padding).
func base64Decode(s string) ([]byte, error) {
	// use encoding/base64
	return base64Std.DecodeString(s)
}

// resizeImage scales imageData down so total pixels stay within maxPixels, preserving aspect ratio.
// format is "png" or "jpeg"; quality is used only for jpeg output.
func resizeImage(imageData []byte, format string, quality, maxPixels, origWidth, origHeight int) ([]byte, int, int, error) {
	src, _, err := image.Decode(bytes.NewReader(imageData))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("decoding image: %w", err)
	}
	// scale = sqrt(maxPixels / totalPixels), applied to both dimensions
	scale := math.Sqrt(float64(maxPixels) / float64(origWidth*origHeight))
	newWidth := int(float64(origWidth) * scale)
	newHeight := int(float64(origHeight) * scale)
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
	pageContentCmd.Flags().String("format", "text", "output format: text, html")

	pageExecCmd.Flags().StringP("file", "f", "", "read JavaScript from file")
	pageExecCmd.Flags().String("world", "ISOLATED", "execution world: MAIN or ISOLATED")
	pageExecCmd.Flags().DurationVar(&pageExecTimeout, "timeout", 45*time.Second,
		"max time to wait for script execution response")

	pageReloadCmd.Flags().Bool("bypass-cache", false, "bypass browser cache on reload")

	pageScreenshotCmd.Flags().String("selector", "", "CSS selector for element screenshot")
	pageScreenshotCmd.Flags().String("format", "png", "image format: png, jpeg")
	pageScreenshotCmd.Flags().Int("quality", 80, "JPEG quality (0-100, ignored for PNG)")
	pageScreenshotCmd.Flags().Bool("full-page", false, "capture full scrollable page")
	pageScreenshotCmd.Flags().StringP("output", "o", "", "save screenshot to file")
	pageScreenshotCmd.Flags().Int("max-pixels", 1_000_000, "resize screenshot if total pixels exceed this limit (0 to disable)")

	pageCmd.AddCommand(pageContentCmd, pageExecCmd, pageReloadCmd, pageScreenshotCmd)
	rootCmd.AddCommand(pageCmd)
}
