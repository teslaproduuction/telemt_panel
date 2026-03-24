package logs

import (
	"bufio"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

type journalctlSource struct {
	serviceName string
}

func newJournalctlSource(serviceName string) (*journalctlSource, error) {
	if serviceName == "" {
		return nil, fmt.Errorf("service_name is required for journalctl log source")
	}
	if !HasJournalctl() {
		return nil, fmt.Errorf("journalctl not found")
	}
	return &journalctlSource{serviceName: serviceName}, nil
}

func (s *journalctlSource) Name() string { return "journalctl" }

func (s *journalctlSource) Tail(ctx context.Context, n int) ([]string, error) {
	n = ClampLines(n)
	cmd := exec.CommandContext(ctx, "journalctl",
		"-u", s.serviceName,
		"-n", fmt.Sprintf("%d", n),
		"--no-pager",
		"-o", "short-iso",
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("journalctl tail: %w", err)
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return []string{}, nil
	}
	return lines, nil
}

func (s *journalctlSource) Stream(ctx context.Context) (<-chan string, error) {
	cmd := exec.CommandContext(ctx, "journalctl",
		"-u", s.serviceName,
		"-f",
		"--no-pager",
		"-o", "short-iso",
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("journalctl pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("journalctl start: %w", err)
	}

	ch := make(chan string, 64)
	go func() {
		defer close(ch)
		defer cmd.Wait()
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			select {
			case ch <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}()

	return ch, nil
}
