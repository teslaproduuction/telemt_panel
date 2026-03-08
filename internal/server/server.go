package server

import (
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"sync"
	"time"

	"golang.org/x/crypto/acme/autocert"

	"github.com/telemt/telemt-panel/internal/auth"
	"github.com/telemt/telemt-panel/internal/config"
	"github.com/telemt/telemt-panel/internal/proxy"
	"github.com/telemt/telemt-panel/internal/spa"
	"github.com/telemt/telemt-panel/internal/updater"
	"github.com/telemt/telemt-panel/internal/ws"
)

// loginRateLimiter tracks failed login attempts per IP.
type loginRateLimiter struct {
	mu       sync.Mutex
	attempts map[string][]time.Time
}

func newLoginRateLimiter() *loginRateLimiter {
	return &loginRateLimiter{attempts: make(map[string][]time.Time)}
}

// allow returns true if the IP has fewer than maxAttempts in the given window.
func (rl *loginRateLimiter) allow(ip string, maxAttempts int, window time.Duration) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-window)

	// Remove expired entries
	valid := rl.attempts[ip][:0]
	for _, t := range rl.attempts[ip] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	rl.attempts[ip] = valid

	return len(valid) < maxAttempts
}

// record adds a failed attempt for the IP.
func (rl *loginRateLimiter) record(ip string) {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.attempts[ip] = append(rl.attempts[ip], time.Now())
}

type Server struct {
	cfg *config.Config
}

func New(cfg *config.Config) *Server {
	return &Server{cfg: cfg}
}

type jsonResponse struct {
	OK   bool        `json:"ok"`
	Data interface{} `json:"data,omitempty"`
}

type loginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"ok": false,
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

func (s *Server) Run(distFS fs.FS) error {
	jwtSecret := []byte(s.cfg.Auth.JWTSecret)

	ttl, err := time.ParseDuration(s.cfg.Auth.SessionTTL)
	if err != nil {
		ttl = 24 * time.Hour
	}

	telemtProxy, err := proxy.NewTelemtProxy(s.cfg.Telemt.URL, s.cfg.Telemt.AuthHeader)
	if err != nil {
		return err
	}

	limiter := newLoginRateLimiter()
	mux := http.NewServeMux()

	// Auth endpoints
	mux.HandleFunc("POST /api/auth/login", func(w http.ResponseWriter, r *http.Request) {
		ip := r.RemoteAddr
		if fwd := r.Header.Get("X-Forwarded-For"); fwd != "" {
			ip = fwd
		}

		if !limiter.allow(ip, 5, 1*time.Minute) {
			writeError(w, http.StatusTooManyRequests, "rate_limited", "too many login attempts, try again later")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, 1<<20) // 1 MB limit
		var req loginRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
			return
		}

		if req.Username != s.cfg.Auth.Username || !auth.CheckPassword(req.Password, s.cfg.Auth.PasswordHash) {
			limiter.record(ip)
			writeError(w, http.StatusUnauthorized, "unauthorized", "invalid credentials")
			return
		}

		token, err := auth.GenerateToken(req.Username, jwtSecret, ttl)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "internal_error", "failed to generate token")
			return
		}

		http.SetCookie(w, &http.Cookie{
			Name:     "session",
			Value:    token,
			Path:     "/",
			MaxAge:   int(ttl.Seconds()),
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
			Secure:   r.TLS != nil,
		})

		writeJSON(w, http.StatusOK, jsonResponse{
			OK:   true,
			Data: map[string]string{"username": req.Username},
		})
	})

	mux.HandleFunc("POST /api/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{
			Name:     "session",
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteStrictMode,
		})
		writeJSON(w, http.StatusOK, jsonResponse{OK: true})
	})

	mux.Handle("GET /api/auth/me", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{
			OK:   true,
			Data: map[string]string{"username": r.Header.Get("X-Auth-User")},
		})
	})))

	// WebSocket endpoint (auth checked via cookie on upgrade)
	wsHandler := ws.NewHandler(s.cfg.Telemt.URL, s.cfg.Telemt.AuthHeader)
	mux.Handle("/api/ws", auth.RequireAuth(jwtSecret, wsHandler))

	// Update endpoints
	upd := updater.New(
		s.cfg.Telemt.URL,
		s.cfg.Telemt.BinaryPath,
		s.cfg.Telemt.ServiceName,
		s.cfg.Telemt.GithubRepo,
		s.cfg.Telemt.AuthHeader,
	)

	mux.Handle("GET /api/update/check", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		result, err := upd.Check()
		if err != nil {
			writeError(w, http.StatusBadGateway, "update_check_failed", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: result})
	})))

	mux.Handle("POST /api/update/apply", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := upd.Apply(); err != nil {
			writeError(w, http.StatusConflict, "update_in_progress", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: upd.GetStatus()})
	})))

	mux.Handle("GET /api/update/status", auth.RequireAuth(jwtSecret, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, jsonResponse{OK: true, Data: upd.GetStatus()})
	})))

	// Telemt API proxy (kept for direct REST calls like user CRUD)
	mux.Handle("/api/telemt/", auth.RequireAuth(jwtSecret, telemtProxy))

	// SPA
	mux.Handle("/", spa.NewHandler(distFS))

	// Wrap mux with security headers
	handler := securityHeaders(mux)

	srv := &http.Server{
		Addr:         s.cfg.Listen,
		Handler:      handler,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	// TLS: ACME (Let's Encrypt)
	if s.cfg.TLS.AcmeDomain != "" {
		manager := &autocert.Manager{
			Cache:      autocert.DirCache(s.cfg.TLS.AcmeCacheDir),
			Prompt:     autocert.AcceptTOS,
			HostPolicy: autocert.HostWhitelist(s.cfg.TLS.AcmeDomain),
		}
		srv.TLSConfig = manager.TLSConfig()

		// HTTP->HTTPS redirect on port 80
		go func() {
			log.Printf("Telemt Panel HTTP->HTTPS redirect on :80")
			if err := http.ListenAndServe(":80", manager.HTTPHandler(nil)); err != nil {
				log.Printf("HTTP redirect server error: %s", err)
			}
		}()

		log.Printf("Telemt Panel listening on %s (ACME TLS, domain: %s)", s.cfg.Listen, s.cfg.TLS.AcmeDomain)
		return srv.ListenAndServeTLS("", "")
	}

	// TLS: custom certificates
	if s.cfg.TLS.CertFile != "" {
		log.Printf("Telemt Panel listening on %s (TLS)", s.cfg.Listen)
		return srv.ListenAndServeTLS(s.cfg.TLS.CertFile, s.cfg.TLS.KeyFile)
	}

	// Plain HTTP
	log.Printf("Telemt Panel listening on %s", s.cfg.Listen)
	return srv.ListenAndServe()
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		if r.TLS != nil {
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}
