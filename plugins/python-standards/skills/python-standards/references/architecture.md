# Python Project (FAST API) Architecture Guidelines

## Project Layout
```text
project/
├── app/
│   ├── main.py                      # FastAPI entrypoint
│   ├── api/                         # Route handlers (versioned)
│   │   ├── __init__.py
│   │   ├── deps.py                  # Common dependencies (e.g., current_user)
│   │   └── v1/
│   │       ├── __init__.py
│   │       ├── user_routes.py
│   │       ├── auth_routes.py       # Login, register, token endpoints
│   │       └── ...
│   ├── core/                        # Core settings and app-level config
│   │   ├── __init__.py
│   │   ├── config.py                # Env-based settings via pydantic
│   │   ├── database.py              # SQLAlchemy DB session engine
│   │   └── constants.py             # Role types, token configs, etc.
│   ├── models/                      # SQLAlchemy models
│   │   ├── __init__.py
│   │   ├── user.py
│   │   ├── auth.py
│   │   └── schemas/                 # Pydantic request/response models
│   │       ├── __init__.py
│   │       ├── user_schema.py
│   │       ├── auth_schema.py
│   │       └── ...
│   ├── services/                    # Business logic
│   │   ├── __init__.py
│   │   ├── user_service.py
│   │   └── auth_service.py
│   ├── utils/                       # Utility helpers
│   │   ├── __init__.py
│   │   ├── logger.py
│   │   ├── helpers.py
│   │   └── security.py              # Password hashing, JWT handling
│   ├── auth/                        # Authorization logic
│   │   ├── __init__.py
│   │   ├── auth_handler.py          # JWT token encode/decode
│   │   ├── auth_bearer.py           # Dependency for token extraction
│   │   └── permissions.py           # Role-based access controls
├── tests/
│   ├── __init__.py
│   ├── test_auth.py
│   ├── test_user.py
│   └── ...
├── .env                             # Actual env vars (DO NOT commit)
├── .env.example                     # Example env file
├── .gitignore
├── README.md
├── Dockerfile                   # Dockerfile for building the app image    
├── docker-compose.yml
# Poetry, Pre-commit, Linting, Typing
├── pyproject.toml                   # Poetry + tool config (black, isort, flake8, mypy)
├── poetry.lock
├── .pre-commit-config.yaml         # Pre-commit hooks for lint, format, etc.
├── .flake8                          # Flake8 configuration
├── .isort.cfg                       # Isort configuration
