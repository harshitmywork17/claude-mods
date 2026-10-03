# Naming Conventions for Python Projects

## General Rules
- Use **intention-revealing** names that describe the purpose.
- Be **descriptive but concise** — avoid cryptic or overly long names.
- Avoid **abbreviations**, unless widely understood (e.g., `id`, `url`).
- Prefer names that are **pronounceable** and **searchable**.
- Use `snake_case` for variable and function names.
- Use `PascalCase` for class names.
- Use `UPPER_SNAKE_CASE` for constants.
- Avoid using single-letter names except for counters or iterators.

## Descriptive Naming
- Use names that clearly indicate the purpose or role of the variable, function, or class.
- Be descriptive but concise.

```python
#  Bad
def calc(u, v): return u + v

#  Good
def calculate_total_price(unit_price, quantity): return unit_price * quantity
```
--- 

## File & Module Naming
- File names should use `snake_case`
- Avoid using special characters or numbers at the beginning.
- Filenames should match their main class or function, if applicable.

```bash

user_service.py
invoice_manager.py
```
---

## Package Naming
- Use all **lowercase** for package and folder names.
- Avoid underscores unless needed for clarity.
```bash

utils/
auth/
email_service/
```

---

## Test Naming
- Prefix test files with `test_`, e.g., `test_auth.py`.
- Use `test_functionName_scenario_expectedOutcome()` format for clarity.
- Test functions should describe scenario and expectation.

```python

def test_user_login_fails_with_wrong_password(): ...
def test_calculate_discount_applies_loyalty_rule(): ...
```

---

##  Variable Naming
- Use `snake_case` for variables.
- Prefer specific names over generic (`user_profile` vs `data`).
- Use `count`, `index`, `temp` only when usage is short-lived and obvious.
- Avoid single-letter names, except for loop indices.

```python
#  Bad
x = 10
y = 5

#  Good
discount_rate = 0.10
max_attempts = 5
```

---

##  Function and Method Naming
- Use `snake_case` for functions and methods.
- Names should be **verb-based**, describing an action.
- Boolean-returning functions should begin with `is_`, `has_`, `should_`, or `can_`.

```python
#  Bad
def handle(): ...
def check(): ...

#  Good
def process_order(): ...
def is_user_authenticated(): ...
```

---

##  Class and Exception Naming
- Use `PascalCase` for class names.
- Class names should be nouns (`User`, `InvoiceManager`).
- Exception classes should end with `Error`.

```python

class PaymentProcessor: ...
class InvalidPaymentError(Exception): ...
```

---

##  Constant Naming
- Use `UPPER_SNAKE_CASE` for constants.
- Define constants at the module level or inside config classes.

```python

MAX_RETRIES = 5
DEFAULT_TIMEOUT_SECONDS = 30
```

---


##  Boolean Variable Naming
- Prefix with `is_`, `has_`, `should_`, `can_`, or `was_`.
- Should clearly express true/false logic.

```python
def is_email_verified(user):
    return user.verified_at is not None
```
---

##  Naming Anti-Patterns to Avoid

1. Pattern: `data`, `info`
   Issue: Too vague/generic                  
   Alternative: `user_profile`, `payment_info`  

2. Pattern: `x`, `y`, `temp`
   Issue: Not meaningful or searchable
   Alternative: `buffer_size`, `retry_count`

3. Pattern: `flag`, `status`
   Issue: Ambiguous purpose
   Alternative: `is_active`, `has_errors`

4. Pattern: `handle`, `do`, `process`
   Issue: Too vague, unclear intent
   Alternative: `send_email`, `update_order`

---


# Additional Naming Conventions for Python Web Development

## Django/Flask Apps & Blueprints
- App and blueprint names should be short, lowercase, and descriptive (e.g., `accounts`, `blog`).
- Avoid generic names like `app` or `main`.

## Views, Routes, and Endpoints
- View function names: use `snake_case` and describe the action, e.g., `create_user`, `get_profile`.
- Route names/URLs: use hyphens for readability, e.g., `/user-profile/`, `/reset-password/`.
- Avoid using verbs in route names for RESTful APIs; use nouns and resources, e.g., `/users/`, `/orders/`.

## Template Naming
- Use `snake_case` for template file names, e.g., `user_profile.html`.
- Organize templates in folders matching app/module names.

## Static Files
- Use lowercase and hyphens for static file names, e.g., `main.css`, `user-avatar.png`.
- Group static files by type or feature in subfolders.

## Forms & Serializers
- Class names should use `PascalCase` and end with `Form` or `Serializer`, e.g., `LoginForm`, `UserSerializer`.

## Database Models
- Model class names: use `PascalCase`, singular, e.g., `User`, `OrderItem`.
- Table names (if specified): use `snake_case`, plural, e.g., `users`, `order_items`.

## Migrations
- Migration files: use auto-generated names or descriptive `snake_case` names, e.g., `0002_add_user_profile.py`.

## Environment Variables
- Use `UPPER_SNAKE_CASE`, e.g., `DATABASE_URL`, `SECRET_KEY`.

## Example Structure
```
myproject/
│
├── accounts/
│   ├── models.py
│   ├── views.py
│   ├── forms.py
│   ├── serializers.py
│   ├── templates/
│   │   └── accounts/
│   │       └── user_profile.html
│   └── static/
│       └── accounts/
│           └── main.css
├── tests/
│   └── test_accounts_user_creation.py
```
```<!-- filepath: c:\Rakesh\Projects\coding guideline\Org-Standards\python\naming.md -->

```