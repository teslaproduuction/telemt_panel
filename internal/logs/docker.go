package logs

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os/exec"
	"strings"
)

type dockerSource struct {
	containerName string
	useSocket     bool // true = Docker API via socket, false = docker CLI
}

func newDockerSource(containerName string) (*dockerSource, error) {
	if containerName == "" {
		return nil, fmt.Errorf("container_name is required for Docker log source")
	}

	useSocket := false
	if IsInsideDocker() {
		if !HasDockerSocket() {
			return nil, fmt.Errorf("running inside Docker but /var/run/docker.sock is not mounted")
		}
		useSocket = true
	} else if !HasDockerCLI() {
		return nil, fmt.Errorf("docker CLI not found")
	}

	return &dockerSource{containerName: containerName, useSocket: useSocket}, nil
}

func (s *dockerSource) Name() string { return "docker" }

func (s *dockerSource) Tail(ctx context.Context, n int) ([]string, error) {
	n = ClampLines(n)
	if s.useSocket {
		return s.tailViaSocket(ctx, n)
	}
	return s.tailViaCLI(ctx, n)
}

func (s *dockerSource) Stream(ctx context.Context) (<-chan string, error) {
	if s.useSocket {
		return s.streamViaSocket(ctx)
	}
	return s.streamViaCLI(ctx)
}

// --- CLI methods ---

func (s *dockerSource) tailViaCLI(ctx context.Context, n int) ([]string, error) {
	cmd := exec.CommandContext(ctx, "docker", "logs",
		"--tail", fmt.Sprintf("%d", n),
		"--timestamps",
		s.containerName,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("docker logs: %s", strings.TrimSpace(string(out)))
	}
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return []string{}, nil
	}
	return lines, nil
}

func (s *dockerSource) streamViaCLI(ctx context.Context) (<-chan string, error) {
	cmd := exec.CommandContext(ctx, "docker", "logs",
		"-f",
		"--timestamps",
		s.containerName,
	)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("docker pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("docker stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("docker start: %w", err)
	}

	ch := make(chan string, 64)
	scanPipe := func(r io.Reader) {
		scanner := bufio.NewScanner(r)
		for scanner.Scan() {
			select {
			case ch <- scanner.Text():
			case <-ctx.Done():
				return
			}
		}
	}
	go func() {
		defer close(ch)
		defer cmd.Wait()
		go scanPipe(stderr)
		scanPipe(stdout)
	}()

	return ch, nil
}

// --- Socket methods (Docker Engine API) ---

func dockerSocketClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", "/var/run/docker.sock")
			},
		},
	}
}

func (s *dockerSource) tailViaSocket(ctx context.Context, n int) ([]string, error) {
	client := dockerSocketClient()
	url := fmt.Sprintf("http://localhost/containers/%s/logs?stdout=1&stderr=1&tail=%d&timestamps=1",
		s.containerName, n)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker API: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("docker API %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	return readDockerLogLines(resp.Body)
}

func (s *dockerSource) streamViaSocket(ctx context.Context) (<-chan string, error) {
	client := dockerSocketClient()
	url := fmt.Sprintf("http://localhost/containers/%s/logs?stdout=1&stderr=1&follow=1&timestamps=1",
		s.containerName)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker API: %w", err)
	}

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("docker API %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	ch := make(chan string, 64)
	go func() {
		defer close(ch)
		defer resp.Body.Close()
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := stripDockerHeader(scanner.Bytes())
			select {
			case ch <- line:
			case <-ctx.Done():
				return
			}
		}
	}()

	return ch, nil
}

// stripDockerHeader removes the 8-byte Docker log stream header if present.
// Docker multiplexed stream format: [type(1)][0(3)][size(4)][payload]
func stripDockerHeader(b []byte) string {
	if len(b) > 8 && (b[0] == 1 || b[0] == 2) && b[1] == 0 && b[2] == 0 && b[3] == 0 {
		return string(b[8:])
	}
	return string(b)
}

// readDockerLogLines reads all lines from a Docker log response, stripping headers.
func readDockerLogLines(r io.Reader) ([]string, error) {
	var lines []string
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		lines = append(lines, stripDockerHeader(scanner.Bytes()))
	}
	if err := scanner.Err(); err != nil {
		return lines, err
	}
	return lines, nil
}
