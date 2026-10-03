---
name: python-standards
description: Org-wide Python coding standards covering clean-code principles (SOLID, DRY, KISS, YAGNI), FastAPI project architecture/layout, naming conventions, secure coding (OWASP-aligned), and linting/testing setup. Use this whenever writing, reviewing, structuring, or refactoring ANY Python code or Python project — new modules, API endpoints, class design, file/folder layout, variable/function/class names, auth or input-handling code, or CI/lint config. Trigger even for small tasks like "name this function," "where should this file go," or "is this endpoint secure," not just explicit requests for "standards" or "guidelines." For FastAPI/Flask/Django web projects specifically, always consult architecture.md and secure-coding.md before proposing a structure or writing auth/data-handling code.
license: MIT
---

# Python Org Standards

Five reference documents, bundled in `references/`, encode this org's Python conventions. Read the specific file(s) relevant to the task at hand — don't guess from memory, and don't load all five for a one-line naming question.

## Which reference to read, when

| File | Read it when the task involves... |
|---|---|
| `references/coding-principles.md` | Class/function design, refactoring, deciding whether to split responsibilities, inheritance vs. composition, applying SOLID/DRY/KISS/YAGNI, error-handling patterns |
| `references/architecture.md` | Starting a new FastAPI project, deciding where a new file/module belongs, project-wide layout, dependency/tooling setup (Poetry, pre-commit) |
| `references/naming.md` | Naming any variable, function, class, file, module, package, route, template, or env var |
| `references/secure-coding.md` | Anything touching auth, sessions/tokens, user input, file uploads, SQL, templates/XSS, CORS, secrets, or deployment config |
| `references/testing.md` | Writing tests, or setting up linting/formatting tooling (black, ruff/flake8, isort, mypy) |

Multiple files often apply to one task — e.g., adding a login endpoint touches architecture (where it lives), naming (route/function names), and secure-coding (auth handling) all at once. Read each relevant file rather than picking one.

## Quick-reference cheat sheet

Use this to sanity-check trivial cases without opening a file; open the file itself for anything non-trivial or before writing real code.

**Design principles (coding-principles.md)**
- One class/function, one reason to change (SRP).
- Don't implement what isn't needed yet (YAGNI) — no speculative methods/config.
- Prefer composition over multiple inheritance for mixing behaviors.
- Depend on abstractions (ABCs), not concrete classes, across module boundaries (DIP).
- Keep list comprehensions to one simple condition; break out complex logic into helper functions or explicit loops (KISS).
- New variant of behavior (discount type, storage backend) → extend via a new strategy class, don't add another `elif` (OCP).
- A method should only reach one level deep into other objects (`self.x.y()`, not `self.x.y.z.w()`) — Law of Demeter.
- Subclasses must be substitutable for their parent without surprising behavior (LSP) — if `Triangle(Rectangle)` needs to override the area formula, it shouldn't inherit from `Rectangle` at all.

**Architecture (architecture.md)**
- Routes in `app/api/v1/`, business logic in `app/services/`, SQLAlchemy models in `app/models/`, Pydantic schemas in `app/models/schemas/`, JWT/permissions in `app/auth/`, cross-cutting config in `app/core/`.
- Tests mirror source structure in `tests/`.
- Tooling config (black/isort/flake8/mypy) lives in `pyproject.toml` + dedicated config files at repo root; pre-commit enforces it.

**Naming (naming.md)**
- `snake_case`: variables, functions, files, modules. `PascalCase`: classes. `UPPER_SNAKE_CASE`: constants.
- Booleans start with `is_`/`has_`/`should_`/`can_`/`was_`.
- Exceptions end in `Error`.
- Tests: `test_<function>_<scenario>_<expected_outcome>`.
- REST routes are nouns (`/users/`), not verbs; hyphens for multi-word paths (`/reset-password/`).
- Never use `data`, `info`, `flag`, `status`, `handle`, `process`, `x`/`y`/`temp` as real names — see anti-pattern table in the file for the specific swap.

**Security (secure-coding.md)**
- Validate all input via pydantic/schemas; never trust query params, bodies, cookies, headers directly.
- Passwords via `bcrypt`/`argon2`; JWTs short-TTL, never exposed to JS.
- Parameterized queries / ORM only — never string-concatenated SQL.
- Auto-escaped templates + CSRF middleware; sanitize any user content rendered as HTML.
- Generic error messages to users; full errors + redacted secrets to logs only.
- No `eval`/`exec`/`pickle.loads`/`os.system`/unsanitized `subprocess`.
- `DEBUG=False` in production; HTTPS + HSTS + standard security headers everywhere.

**Testing & linting (testing.md)**
- `black` formats, `ruff`/`flake8` lints, `isort` sorts imports, `mypy` type-checks.
- Config lives at repo root (`.flake8`, `pyproject.toml`, `mypy.ini`); enforced via pre-commit + CI.

## How to apply this during a task

1. Identify which reference(s) the current task touches (see table above).
2. Read the actual file(s) — the cheat sheet above is for quick recall, not a substitute for the full doc when writing real code or making a structural decision.
3. Apply the relevant conventions directly in the code you write; don't just mention them as caveats afterward.
4. If a request conflicts with a standard here (e.g., asks for a flat file layout, or string-built SQL), say so explicitly and propose the compliant alternative rather than silently following the standard or silently ignoring it.
