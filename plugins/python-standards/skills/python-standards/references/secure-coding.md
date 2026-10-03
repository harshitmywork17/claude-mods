# Python Secure Coding Standards for Web/API Development

This document outlines secure coding practices for Python web development (Flask, Django, FastAPI). These standards help prevent common vulnerabilities, promote consistency, and improve the overall security posture of your APIs and web applications.

---

## 1. Input Validation & Sanitization

- Validate all incoming data using serializers or schemas (`pydantic`, Django Forms, `marshmallow`).
- Never trust data from query parameters, request bodies, cookies, or headers.
- Sanitize rich text and file inputs using `bleach`, `html-sanitizer`, or regex filters.
- Reject malformed JSON, invalid types, and excessive payload sizes.

---

## 2. Authentication & Authorization

- Use established libraries for authentication (e.g., Django Auth, FastAPI OAuth2PasswordBearer).
- Implement Role-Based Access Control (RBAC) or Attribute-Based Access Control (ABAC).
- Store passwords using secure hash functions (`bcrypt`, `argon2`).
- Implement login throttling and account lockout for repeated failures.
- Validate authorization for every resource access (e.g., record ownership checks).

---

## 3. Session & Token Management

- Use signed and encrypted session cookies; set `Secure`, `HttpOnly`, and `SameSite=Strict` flags.
- Implement session timeout and rotation policies.
- Use JWTs with short TTLs; securely store and verify them.
- Never expose access/refresh tokens to JavaScript directly.

---

## 4. SQL Injection Prevention

- Always use parameterized queries or ORM abstractions (e.g., SQLAlchemy, Django ORM).
- Never construct SQL dynamically using string concatenation.
- Sanitize data even when using an ORM for additional defense.

---

## 5. Cross-Site Scripting (XSS) & CSRF Protection

- Auto-escape output in all templates (Jinja2, Django templates).
- Use CSRF tokens and middleware provided by your framework.
- Sanitize user content displayed in templates using `bleach`.
- Avoid using `dangerouslySetInnerHTML` or similar constructs in frontend-rendered content.

---

## 6. API Rate Limiting & Throttling

- Apply per-IP, per-user, or per-endpoint rate limits using libraries like `slowapi`, `django-ratelimit`.
- Handle abuse with exponential backoff or temporary blocks.
- Respond with proper status codes like `429 Too Many Requests`.

---

## 7. Error Handling & Logging

- Return generic error messages to users. Avoid exposing internal logic or stack traces.
- Log full errors securely, including request metadata and traceback.
- Mask or redact sensitive information (passwords, tokens) from logs.
- Separate application logs from security logs.

---

## 8. Secure Dependency Management

- Use tools like `pip-audit`, `bandit`, `safety`, and `dependabot` to scan dependencies.
- Pin dependencies using `requirements.txt`, `Pipfile.lock`, or `poetry.lock`.
- Avoid installing dependencies from untrusted sources or URLs.

---

## 9. File Uploads & Downloads

- Use `secure_filename` from `werkzeug` to sanitize uploaded file names.
- Restrict allowed MIME types and file extensions.
- Scan uploaded files for viruses.
- Store files outside of the web root and use signed URLs or controlled APIs for access.

---

## 10. Secure Headers & HTTPS

- Force HTTPS using HSTS (`Strict-Transport-Security`).
- Set HTTP security headers:
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Content-Security-Policy`
  - `Referrer-Policy: no-referrer`
- Redirect all HTTP traffic to HTTPS.

---

## 11. JSON & XML Handling

- Use safe libraries for parsing JSON and XML.
- Prevent XML External Entity (XXE) attacks using `defusedxml`.
- Avoid deserializing untrusted data (especially `pickle` or YAML).

---

## 12. CORS Configuration

- Use strict `Access-Control-Allow-Origin` headers.
- Avoid setting `Access-Control-Allow-Origin: *` on APIs that require authentication.
- Only allow trusted origins and limit allowed HTTP methods.

---

## 13. Configuration & Secrets Management

- Use `.env` files for local development but never commit them to source control.
- Load secrets using `os.environ`, `dynaconf`, or `python-decouple`.
- Rotate secrets periodically and use secure secret stores in production (e.g., AWS Secrets Manager, HashiCorp Vault).

---

## 14. Secure Code Execution

- Avoid unsafe functions:
  - `eval()`, `exec()`, `pickle.loads()`, `os.system()`, `subprocess` with unsanitized input.
- If needed, sanitize all inputs and use safe alternatives (`subprocess.run()` with `shell=False`).

---

## 15. Static Code Analysis

- Use `bandit`, `mypy`, `pylint`, `flake8`, and `black` for linting and static analysis.
- Integrate these tools into CI/CD pipelines.
- Block merges that fail security linting checks.

---

## 16. Logging & Monitoring

- Use structured logging with unique request IDs.
- Use tools like Sentry, ELK Stack, Prometheus, or CloudWatch for central logging.
- Monitor for security anomalies (e.g., login abuse, token misuse).

---

## 17. Code Review & Approval

- Mandate security-focused peer code reviews.
- Use checklists to ensure coverage of secure practices (e.g., input validation, auth checks).
- Avoid merging directly to `main` or `master` without approval.

---

## 18. Secure Deployment Practices

- Never run in `DEBUG=True` mode in production.
- Use WSGI/ASGI servers (e.g., Gunicorn, Uvicorn) with proper worker configurations.
- Containerize services using secure base images and scan them regularly (`trivy`, `snyk`).
- Patch OS-level and dependency vulnerabilities during deployments.

---

## 19. Secure API Design

- Use RESTful conventions with clear method usage (GET, POST, PUT, DELETE).
- Validate and normalize data at the boundary.
- Avoid exposing sensitive implementation details (e.g., stack traces, error IDs).

---

## 20. Security Testing

- Include unit tests for edge cases and invalid input.
- Use security testing tools:
  - `pytest`, `hypothesis` for fuzz testing
  - `OWASP ZAP` or `Burp Suite` for dynamic scans
- Periodically conduct security audits or penetration tests.

---

## References

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [OWASP API Security Top 10](https://owasp.org/www-project-api-security/)
- [Python Security](https://owasp.org/www-project-python-security/)
- [Bandit - Security Linter](https://github.com/PyCQA/bandit)
- [pip-audit](https://pypi.org/project/pip-audit/)
- [FastAPI Security Best Practices](https://fastapi.tiangolo.com/advanced/security/)
