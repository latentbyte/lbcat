package browsercontrol

import (
	"fmt"
	"slices"
	"strings"
)

// ResolveBrowserAlias maps a browser name ("zen") to the sole connected ID with that name ("zen-11").
// Exact IDs and unmatched values pass through unchanged so the daemon reports unknown targets.
func ResolveBrowserAlias(requested string, connected []string) (string, error) {
	if requested == "" || slices.Contains(connected, requested) {
		return requested, nil
	}
	var matches []string
	for _, id := range connected {
		if strings.EqualFold(browserNameFromID(id), requested) {
			matches = append(matches, id)
		}
	}
	switch len(matches) {
	case 0:
		return requested, nil
	case 1:
		return matches[0], nil
	default:
		return "", fmt.Errorf("multiple %s browsers connected: %s; pass an exact ID", requested, strings.Join(matches, ", "))
	}
}
