package logs

import "context"

// LogSource provides access to service logs.
type LogSource interface {
	// Tail returns the last n lines.
	Tail(ctx context.Context, n int) ([]string, error)
	// Stream returns a channel that emits new log lines in real-time.
	// The channel is closed when ctx is cancelled or the source process exits.
	Stream(ctx context.Context) (<-chan string, error)
	// Name returns the source type ("journalctl" or "docker").
	Name() string
}

// ClampLines clamps n to [1, 5000].
func ClampLines(n int) int {
	if n < 1 {
		return 1
	}
	if n > 5000 {
		return 5000
	}
	return n
}
