---
description: 'Code review instructions for Telemt Panel project using GitHub Copilot'
applyTo: '**'
excludeAgent: ["coding-agent"]
---

# Code Review Instructions

Code review guidelines for the Telemt Panel project. Follow these rules when reviewing pull requests.

## Review Language

When performing a code review, respond in **Russian**.

## Review Priorities

When performing a code review, prioritize issues in the following order:

### CRITICAL (Block merge)
- **Security**: Vulnerabilities, exposed secrets, authentication/authorization issues (JWT tokens, API keys in code)
- **Correctness**: Logic errors, data corruption risks, race conditions in goroutines
- **Breaking Changes**: WebSocket protocol changes, config format changes without migration
- **Data Loss**: Risk of data loss or corruption

### IMPORTANT (Requires discussion)
- **Code Quality**: Severe violations of SOLID principles, excessive duplication
- **Test Coverage**: Missing tests for critical paths or new functionality
- **Performance**: Goroutine leaks, unclosed resources, unbuffered channels in hot paths
- **Architecture**: Significant deviations from established patterns in `internal/` packages

### SUGGESTION (Non-blocking improvements)
- **Readability**: Poor naming, complex logic that could be simplified
- **Optimization**: Performance improvements without functional impact
- **Best Practices**: Minor deviations from idiomatic Go conventions
- **Documentation**: Missing or incomplete comments on exported symbols

## General Review Principles

When performing a code review, follow these principles:

1. **Be specific**: Reference exact lines, files, and provide concrete examples
2. **Provide context**: Explain WHY something is an issue and the potential impact
3. **Suggest solutions**: Show corrected code when applicable, not just what's wrong
4. **Be constructive**: Focus on improving the code, not criticizing the author
5. **Recognize good practices**: Acknowledge well-written code and smart solutions
6. **Be pragmatic**: Not every suggestion needs immediate implementation
7. **Group related comments**: Avoid multiple comments about the same topic

## Code Quality Standards

When performing a code review, check for:

### Clean Code
- Descriptive and meaningful names for variables, functions, and types
- Single Responsibility Principle: each function/type does one thing well
- DRY (Don't Repeat Yourself): no code duplication
- Functions should be small and focused (ideally < 20-30 lines)
- Avoid deeply nested code (max 3-4 levels); use early returns and guard clauses
- Avoid magic numbers and strings (use constants)
- Code should be self-documenting; comments only when necessary to explain WHY

### Examples
```go
// BAD: Poor naming and magic numbers
func calc(x, y float64) float64 {
	if x > 100 {
		return y * 0.15
	}
	return y * 0.10
}

// GOOD: Clear naming and constants
const (
	premiumThreshold    = 100.0
	premiumDiscountRate = 0.15
	standardDiscountRate = 0.10
)

func calculateDiscount(orderTotal, itemPrice float64) float64 {
	if orderTotal > premiumThreshold {
		return itemPrice * premiumDiscountRate
	}
	return itemPrice * standardDiscountRate
}
```

### Error Handling
- Check errors immediately after the function call
- Wrap errors with context using `fmt.Errorf("context: %w", err)`
- No silent failures or ignored errors (no `_ = someFunc()` without justification)
- Fail fast: validate inputs early with early returns
- Use custom error types when callers need to check specific errors

### Examples
```go
// BAD: Silent failure
func processConfig(path string) {
	data, _ := os.ReadFile(path)
	_ = toml.Unmarshal(data, &config)
}

// GOOD: Explicit error handling with context
func processConfig(path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("reading config %s: %w", path, err)
	}
	if err := toml.Unmarshal(data, &config); err != nil {
		return fmt.Errorf("parsing config %s: %w", path, err)
	}
	return nil
}
```

## Security Review

When performing a code review, check for security issues:

- **Sensitive Data**: No passwords, API keys, JWT secrets, or PII in code or logs
- **Input Validation**: All user inputs from HTTP/WebSocket are validated and sanitized
- **Path Traversal**: File paths from user input must be validated (especially in log file access)
- **Authentication**: JWT token validation before accessing protected resources
- **Authorization**: Verify user has permission to perform action
- **Cryptography**: Use `golang.org/x/crypto` and standard library, never roll your own crypto
- **Dependency Security**: Check for known vulnerabilities in dependencies

### Examples
```go
// BAD: Exposed secret in code
const jwtSecret = "my-super-secret-key-123"

// GOOD: Use configuration or environment
func NewAuthService(cfg *config.Config) *AuthService {
	return &AuthService{secret: cfg.Auth.JWTSecret}
}
```

```go
// BAD: Path traversal vulnerability
func handleLogRequest(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("file")
	data, _ := os.ReadFile(path)
	w.Write(data)
}

// GOOD: Validate and restrict path
func handleLogRequest(w http.ResponseWriter, r *http.Request) {
	name := filepath.Base(r.URL.Query().Get("file"))
	path := filepath.Join(allowedLogDir, name)
	data, err := os.ReadFile(path)
	if err != nil {
		http.Error(w, "log not found", http.StatusNotFound)
		return
	}
	w.Write(data)
}
```

## Testing Standards

When performing a code review, verify test quality:

- **Coverage**: Critical paths and new functionality must have tests
- **Test Names**: Descriptive names using `Test_functionName_scenario` pattern
- **Test Structure**: Use table-driven tests with `t.Run` subtests
- **Independence**: Tests should not depend on each other or external state
- **Assertions**: Use specific assertions with clear failure messages
- **Edge Cases**: Test boundary conditions, nil values, empty inputs

### Examples
```go
// BAD: Vague name and weak assertion
func TestCalc(t *testing.T) {
	result := calc(5, 10)
	if result == 0 {
		t.Fatal("unexpected")
	}
}

// GOOD: Table-driven test with descriptive names
func Test_calculateDiscount(t *testing.T) {
	tests := []struct {
		name       string
		orderTotal float64
		itemPrice  float64
		want       float64
	}{
		{"standard discount for small order", 50, 20, 2.00},
		{"premium discount for large order", 150, 20, 3.00},
		{"boundary at threshold", 100, 20, 2.00},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := calculateDiscount(tt.orderTotal, tt.itemPrice)
			if got != tt.want {
				t.Errorf("calculateDiscount(%v, %v) = %v, want %v",
					tt.orderTotal, tt.itemPrice, got, tt.want)
			}
		})
	}
}
```

## Performance Considerations

When performing a code review, check for performance issues:

- **Goroutine Leaks**: Every goroutine must have a clear exit path
- **Resource Cleanup**: Use `defer` for closing files, connections, response bodies
- **WebSocket**: Proper connection lifecycle management, no leaked connections
- **Memory**: Preallocate slices when size is known, avoid unnecessary allocations
- **Concurrency**: Correct use of `sync.Mutex`, channels; no data races

### Examples
```go
// BAD: Goroutine leak - no exit condition
func monitor(ch chan string) {
	go func() {
		for msg := range ch {
			log.Println(msg)
		}
	}()
}

// GOOD: Goroutine with context cancellation
func monitor(ctx context.Context, ch chan string) {
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				log.Println(msg)
			}
		}
	}()
}
```

## Architecture and Design

When performing a code review, verify architectural principles:

- **Package Boundaries**: `internal/` packages should not leak implementation details
- **Separation of Concerns**: Clear boundaries between auth, config, logs, github, proxy modules
- **Dependency Direction**: High-level modules don't depend on low-level details
- **Interface Segregation**: Prefer small, focused interfaces
- **Loose Coupling**: Components should be independently testable
- **Consistent Patterns**: Follow established patterns in the codebase
- **Frontend Embedding**: Changes to `frontend/` must not break `embed.go` integration

## Comment Format Template

When performing a code review, use this format for comments:

```markdown
**[PRIORITY] Category: Brief title**

Detailed description of the issue or suggestion.

**Why this matters:**
Explanation of the impact or reason for the suggestion.

**Suggested fix:**
[code example if applicable]
```

### Example Comments

#### Critical Issue
````markdown
**CRITICAL - Security: JWT secret exposed in source code**

The JWT signing key is hardcoded on line 23 of `internal/auth/jwt.go`.

**Why this matters:**
Anyone with access to the repository can forge valid JWT tokens and
bypass authentication entirely.

**Suggested fix:**
```go
// Load from config instead of hardcoding
func NewAuthService(cfg *config.Config) *AuthService {
    return &AuthService{secret: []byte(cfg.Auth.JWTSecret)}
}
```
````

#### Important Issue
````markdown
**IMPORTANT - Concurrency: Goroutine leak in WebSocket handler**

The goroutine spawned on line 87 of `internal/ws/handler.go` has no
exit path when the client disconnects.

**Why this matters:**
Each leaked goroutine consumes memory and a system thread. Under load,
this can exhaust server resources.

**Suggested fix:**
Use `context.Context` from the request and select on `ctx.Done()`.
````

#### Suggestion
````markdown
**SUGGESTION - Readability: Simplify nested conditionals**

The nested if statements on lines 30-40 make the logic hard to follow.

**Why this matters:**
Simpler code is easier to maintain and debug.

**Suggested fix:**
```go
// Instead of nested ifs, use guard clauses:
if user == nil || !user.IsActive || !user.HasPermission("write") {
    return ErrUnauthorized
}
// proceed with action
```
````

## Review Checklist

When performing a code review, systematically verify:

### Code Quality
- [ ] Code follows idiomatic Go conventions (`gofmt`, `go vet` clean)
- [ ] Names are descriptive and follow Go naming conventions (mixedCaps)
- [ ] Functions are small and focused
- [ ] No code duplication
- [ ] Error handling is explicit with context wrapping
- [ ] No commented-out code or TODO without tickets

### Security
- [ ] No sensitive data in code or logs
- [ ] Input validation on all HTTP/WebSocket inputs
- [ ] JWT authentication properly enforced on protected endpoints
- [ ] File path access is restricted and validated
- [ ] Dependencies are up-to-date and secure

### Testing
- [ ] New code has appropriate test coverage
- [ ] Tests use table-driven pattern with `t.Run`
- [ ] Tests cover edge cases and error scenarios
- [ ] Tests are independent and deterministic

### Performance
- [ ] No goroutine leaks (every goroutine has exit path)
- [ ] Resources properly closed with `defer`
- [ ] No data races (safe concurrent access to shared state)
- [ ] WebSocket connections properly managed

### Architecture
- [ ] Follows established patterns in `internal/` packages
- [ ] Proper separation of concerns between modules
- [ ] No circular dependencies between packages
- [ ] Changes are backward-compatible with existing config format

## Project Context

- **Tech Stack**: Go 1.24, standard library, gorilla/websocket, golang-jwt/v5, BurntSushi/toml
- **Frontend**: React 18 + TypeScript + Tailwind CSS + Vite (embedded into binary)
- **Architecture**: Modular monolith with `internal/` packages (auth, config, logs, github, proxy, geoip, auto_update)
- **Build**: Makefile, static linking (CGO_ENABLED=0), cross-compilation for Linux x86_64/aarch64
- **Testing**: Standard `go test` with table-driven tests
- **CI/CD**: GitHub Actions (build + test on PR, release on tags)
- **Code Style**: Idiomatic Go, `gofmt`/`goimports` formatted
