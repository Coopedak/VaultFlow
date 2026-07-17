# Stack Standards: Python

Extends [`coding-standards.md`](coding-standards.md). Local code style still wins on §1.4 matters.

## Language & style
- Target the version the project already uses (check `pyproject.toml` / `setup.cfg` / `.python-version`).
  Don't use syntax newer than that target.
- Follow PEP 8 as the floor, but match the project's existing line length, quote style, and import
  ordering — if the repo runs `black`/`ruff`/`isort`, produce output those tools leave unchanged.
- Type-hint public functions and non-trivial signatures. Don't add hints to a module that has none
  unless the task is typing it; match what's there.
- f-strings for interpolation, `pathlib` over `os.path` for new path work, context managers (`with`)
  for anything that opens a resource.

## Structure & dependencies
- Match the project's layout (`src/` layout vs flat, package `__init__.py` conventions).
- Add dependencies only where the project already declares them (`pyproject.toml`, `requirements*.txt`)
  and pin the way siblings are pinned. Don't introduce a second dependency/venv tool.
- Prefer the stdlib and libraries already in the project over new third-party ones for small needs.

## Correctness & safety
- No mutable default arguments (`def f(x=[])`); use `None` and build inside.
- Never a bare `except:` — catch the narrowest exception that can actually be raised; don't swallow it silently.
- Use the `logging` module, not `print`, for anything that isn't CLI user output.
- Parameterize SQL and never build shell commands by string concatenation (`subprocess` with a list, not `shell=True` on user input).

## Reviewer hot-spots
Mutable default args, bare/overbroad `except`, swallowed exceptions, `print` used as logging,
missing/wrong type hints where the module is typed, `shell=True` or SQL string-building on external
input, resources opened without a context manager, and adding a parallel dep/format tool the project
doesn't use.
