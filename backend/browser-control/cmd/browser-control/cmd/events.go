package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os/signal"
	"strings"
	"syscall"

	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol"
	"github.com/scriptscat/scriptcat/backend/browser-control/pkg/browsercontrol/model"
	"github.com/spf13/cobra"
)

var eventsCmd = &cobra.Command{
	Use:   "events",
	Short: "Stream Browser Control events",
	RunE: func(cmd *cobra.Command, args []string) error {
		typesFlag, _ := cmd.Flags().GetString("type")
		events, err := parseEventTypes(typesFlag)
		if err != nil {
			return err
		}

		ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
		defer cancel()

		client, err := browsercontrol.New(ctx)
		if err != nil {
			return err
		}
		defer client.Close()

		stream, err := client.Subscribe(ctx, browsercontrol.SubscribeOptions{
			BrowserID:           browserIDFromFlag(),
			AllBrowsers:         flagBrowser == "",
			Events:              events,
			SessionID:           sessionFromFlag(),
			NotifyMissingWindow: true,
		})
		if err != nil {
			return err
		}

		for evt := range stream {
			if flagJSON {
				data, err := json.Marshal(evt)
				if err != nil {
					return err
				}
				fmt.Fprintln(cmd.OutOrStdout(), string(data))
				continue
			}
			fmt.Fprintln(cmd.OutOrStdout(), formatEvent(evt))
		}
		return nil
	},
}

func parseEventTypes(raw string) ([]model.EventType, error) {
	if raw == "" || raw == "all" {
		return nil, nil
	}
	var out []model.EventType
	for _, part := range strings.Split(raw, ",") {
		name := strings.TrimSpace(part)
		if name == "" {
			continue
		}
		typ := model.EventType(name)
		switch typ {
		case model.EventTypeTabFocused,
			model.EventTypeTabRemoved,
			model.EventTypeTabUpdated,
			model.EventTypeTabCreated,
			model.EventTypeBrowserConnected,
			model.EventTypeBrowserDisconnected:
			out = append(out, typ)
		default:
			return nil, fmt.Errorf("unknown event type %q", name)
		}
	}
	return out, nil
}

func formatEvent(evt model.Event) string {
	parts := []string{string(evt.Type)}
	if evt.BrowserID != "" {
		parts = append(parts, string(evt.BrowserID))
	}
	if evt.Tab != nil {
		parts = append(parts, fmt.Sprintf("tab=%d", evt.Tab.ID), evt.Tab.Title)
	} else if evt.TabID != nil {
		parts = append(parts, fmt.Sprintf("tab=%d", evt.TabID.TabID))
	}
	return strings.Join(parts, " ")
}

func init() {
	eventsCmd.Flags().String("type", "", "comma-separated event types: tab-focused,tab-removed,tab-updated,tab-created,browser-connected,browser-disconnected")
	rootCmd.AddCommand(eventsCmd)
}
