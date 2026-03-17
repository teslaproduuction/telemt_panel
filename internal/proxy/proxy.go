package proxy

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"
)

type TelemtProxy struct {
	handler    http.Handler
	targetURL  string
	authHeader string
}

type SystemInfo struct {
	ConfigPath string `json:"config_path"`
	ConfigHash string `json:"config_hash"`
}

func NewTelemtProxy(targetURL string, authHeader string) (*TelemtProxy, error) {
	target, err := url.Parse(targetURL)
	if err != nil {
		return nil, err
	}

	tp := &TelemtProxy{
		targetURL:  targetURL,
		authHeader: authHeader,
	}

	proxy := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.URL.Path = strings.TrimPrefix(r.Out.URL.Path, "/api/telemt")
			if r.Out.URL.Path == "" {
				r.Out.URL.Path = "/"
			}
			r.Out.Host = target.Host

			if authHeader != "" {
				r.Out.Header.Set("Authorization", authHeader)
			}

			r.Out.Header.Del("Cookie")
		},
		ModifyResponse: func(resp *http.Response) error {
			// Touch config after successful mutating requests to /v1/users
			// so Telemt picks up changes via hot-reload
			if resp.StatusCode >= 200 && resp.StatusCode < 300 &&
				strings.Contains(resp.Request.URL.Path, "/v1/users") &&
				resp.Request.Method != http.MethodGet {
				go tp.touchConfig()
			}
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`{"ok":false,"error":{"code":"bad_gateway","message":"telemt API unavailable"}}`))
		},
	}

	tp.handler = proxy
	return tp, nil
}

// touchConfig fetches the config path from Telemt and touches the file
// to trigger hot-reload after user mutations via API.
func (p *TelemtProxy) touchConfig() {
	info, err := p.GetSystemInfo()
	if err != nil {
		log.Printf("[proxy] touch config: failed to get system info: %v", err)
		return
	}
	now := time.Now()
	if err := os.Chtimes(info.ConfigPath, now, now); err != nil {
		log.Printf("[proxy] touch config %s: %v", info.ConfigPath, err)
	}
}

func (p *TelemtProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.handler.ServeHTTP(w, r)
}

func (p *TelemtProxy) GetSystemInfo() (*SystemInfo, error) {
	req, err := http.NewRequest("GET", p.targetURL+"/v1/system/info", nil)
	if err != nil {
		return nil, err
	}

	if p.authHeader != "" {
		req.Header.Set("Authorization", p.authHeader)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("telemt API returned status %d", resp.StatusCode)
	}

	var result struct {
		Data SystemInfo `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}

	return &result.Data, nil
}
