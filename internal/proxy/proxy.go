package proxy

import (
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

func NewTelemtProxy(targetURL string, authHeader string) (http.Handler, error) {
	target, err := url.Parse(targetURL)
	if err != nil {
		return nil, err
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
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			w.Write([]byte(`{"ok":false,"error":{"code":"bad_gateway","message":"telemt API unavailable"}}`))
		},
	}

	return proxy, nil
}
