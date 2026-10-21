package cmd

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"

	"github.com/scriptscat/scriptcat/backend/browser-control/internal/cli"
	"github.com/spf13/cobra"
)

// uploadChunkChars keeps each base64 chunk (a multiple of 4) well under the 1 MB native-messaging frame
const uploadChunkChars = 512 * 1024

// uploadMaxChars matches the extension's cap on buffered base64 per file
const uploadMaxChars = 64 * 1024 * 1024

var pageUploadCmd = &cobra.Command{
	Use:   "upload <tab-id> [selector|@ref] --file PATH",
	Short: "Set files on a file input (works with hidden inputs behind labels and drop zones)",
	Long: `Set local files on an <input type=file> and fire input/change, without opening the file picker.
Locate the input by selector, @ref, or --text (its label or the button/label that opens it); a selector or ref may
point at a container or label that holds the input. With no locator, the page's only file input is used.
Repeat --file for inputs that accept multiple files. Files are capped at about 48 MB each.`,
	Example: "  page upload 12 --file ~/cv.pdf\n  page upload 12 --text Attach --file a.png --file b.png\n  page upload 12 '#dropzone' --file data.csv",
	Args:    cobra.RangeArgs(1, 2),
	RunE: func(cmd *cobra.Command, args []string) error {
		tabID, err := parseTabArg(args[0])
		if err != nil {
			return err
		}
		paths, _ := cmd.Flags().GetStringArray("file")
		if len(paths) == 0 {
			return fmt.Errorf("provide at least one --file")
		}
		type upload struct {
			name, mimeType, id, data string
		}
		uploads := make([]upload, len(paths))
		for i, path := range paths {
			content, err := os.ReadFile(path)
			if err != nil {
				return fmt.Errorf("reading %s: %w", path, err)
			}
			data := base64.StdEncoding.EncodeToString(content)
			if len(data) > uploadMaxChars {
				return fmt.Errorf("%s is too large to upload (%d bytes)", path, len(content))
			}
			mimeType, _, _ := strings.Cut(mime.TypeByExtension(filepath.Ext(path)), ";")
			id := make([]byte, 8)
			if _, err := rand.Read(id); err != nil {
				return err
			}
			uploads[i] = upload{filepath.Base(path), mimeType, hex.EncodeToString(id), data}
		}
		request := locatorArgs(cmd, optionalArg(args, 1), map[string]any{"tabId": tabID})
		if err := snapshotArgs(cmd, request); err != nil {
			return err
		}
		request, timeout, err := waitArgs(cmd, request)
		if err != nil {
			return err
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
		files := make([]map[string]any, len(uploads))
		for i, file := range uploads {
			// an empty file still sends one empty chunk so the upload ID exists
			for start := 0; ; start += uploadChunkChars {
				end := min(start+uploadChunkChars, len(file.data))
				chunk := map[string]any{"uploadId": file.id, "data": file.data[start:end]}
				if _, err := c.Request(target, cli.ExtCommand{Cmd: "page.upload.chunk", Args: chunk}); err != nil {
					return fmt.Errorf("sending %s: %w", file.name, err)
				}
				if end == len(file.data) {
					break
				}
			}
			files[i] = map[string]any{"name": file.name, "type": file.mimeType, "uploadId": file.id}
		}
		request["files"] = files
		request["timeoutMs"] = int(timeout.Milliseconds())
		resp, err := c.RequestWithTimeout(target, cli.ExtCommand{Cmd: "page.upload", Args: request}, timeout+pageRequestMargin)
		if err != nil {
			return err
		}
		result, err := decodePageResult(cmd, "page.upload", resp)
		if err != nil || result == nil {
			return err
		}
		names := make([]string, len(uploads))
		for i, file := range uploads {
			names[i] = file.name
		}
		return printPageResult(cmd, "uploaded "+strings.Join(names, ", ")+" to", result)
	},
}

func init() {
	pageUploadCmd.Flags().StringArray("file", nil, "local file to upload (repeatable)")
	pageUploadCmd.Flags().String("text", "", "match the input by its label or the button/label that opens it")
	pageUploadCmd.Flags().Int("nth", 0, "pick the Nth match (1-based) instead of failing with AMBIGUOUS_MATCH")
	addWaitFlags(pageUploadCmd)
	addSnapshotFlag(pageUploadCmd)
	pageCmd.AddCommand(pageUploadCmd)
}
