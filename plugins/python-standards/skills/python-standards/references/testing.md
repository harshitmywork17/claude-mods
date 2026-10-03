
---

### `linting.md` — Linting Rules and Configuration

```md
# Python Linting Configuration

## Tools
- `black` for formatting
- `flake8` or `ruff` for linting
- `isort` for import sorting
- `mypy` for type checking

## Configuration
- Place all config files in the root:
  - `.flake8`
  - `pyproject.toml` (for `black`, `isort`)
  - `mypy.ini`

## Automation
- Integrate with pre-commit hooks.
- Add to CI workflows for enforcement.