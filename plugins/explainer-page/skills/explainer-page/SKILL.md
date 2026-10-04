---
name: explainer-page
description: Builds a textbook-style interactive HTML explainer page that teaches one technical concept through linked representations (colour-coded notation used identically in prose, maths, figures, tables and code; figures and tables drawn from one data source and highlighted together on hover; runnable code with its real output; margin notes, callouts and check-yourself questions). Use only when the person explicitly asks for a page, artifact, HTML, visual or interactive explainer, lesson page, or textbook-style page that teaches a concept, for example "make an interactive page explaining attention", "build a visual explainer for joint distributions", "turn this derivation into a textbook page". Do not use for explanations answered in chat, quizzes or flashcards without a page, dashboards, apps, slide decks, or documents.
license: MIT
---

# Explainer page

Produce one self-contained HTML page that teaches one concept the way a good illustrated textbook does: every idea shown in words, in symbols, in a picture and in code, with each symbol keeping the same colour wherever it appears, and with the picture, the table and the code all drawn from the same numbers.

This skill defines the page's structure and voice completely. Write the page as described here, not in a question-and-answer, interview or drill format, whatever format other instructions set for chat replies.

## Files

- `assets/template.html`: a complete, working page (theme, layout, contents sidebar, notation colours, MathJax, code highlighting, and helpers for linked tables, isometric 3D bars, node diagrams, sliders and code cells). Every page starts as a copy of it.
- `references/components.md`: each component with the markup to paste and when to use it. Read it before writing the page.

## Workflow

### 1. Scope the page

One concept per page; a page has 3 to 6 numbered sections. Before writing, settle in a few lines of notes:

- **The question the concept answers**: the problem a reader would hit without it.
- **Prerequisites**: what the reader must already know; name them in the opening paragraph rather than teaching them.
- **The one picture**: the figure that makes the idea click. Every page has at least one figure; a page about a formula has a figure of what the formula computes.
- **The worked numbers**: a small concrete example (a 5-word vocabulary, a 3-feature input, a 4×4 matrix) used throughout the page. Choose them so every figure shows a contrast: a decision line that splits the points, a distribution with one clear peak, a change that flips a result. Numbers where everything lands on one side teach nothing. Keep quantities realistic: counts are whole numbers.

### 2. Fix the notation before drafting

List every symbol the page uses and give each one a role. Roles map to colours, and the mapping never changes within a page:

| Role | Class / macro | Use for |
|---|---|---|
| input | `.in`, `\inp{}` | given or observed quantities: data, features, the previous token |
| output | `.out`, `\outp{}` | targets, predictions, the next token |
| parameter | `.prm`, `\prm{}` | weights, biases, learned or tunable values, knobs on a slider |
| function | `.fn`, `\fn{}` | models, operators, the function being studied |
| probability | `.pr`, `\pr{}` | probabilities, scores, losses: the numbers a reader reads off |

Leave indices, constants and plain arithmetic uncoloured. A symbol's colour is the same in prose (`<span class="in">`), maths (`\inp{x}`), figure labels and table headers, and code comments may name the role. Introduce each symbol in words the first time it appears.

### 3. Write the page from the template

Copy `assets/template.html` and replace only these parts:

1. `<title>` and the `<h1>` in the top bar: a short name for the concept.
2. Everything between `CONTENT START` and `CONTENT END`.
3. The `DATA` object: the worked numbers, defined once.
4. `drawFigures()` and `writeCode()`: draw every figure and table, and write every code cell, from `DATA`.

Keep the `<style>` block, the shell, and the helper functions. Add CSS only for something no component covers, using the existing colour tokens.

**Each section follows this order**, skipping steps that do not apply:

1. **Motivation**: the problem in one or two sentences, in plain words.
2. **The idea in words**: what the concept does, before any symbol.
3. **The formal statement**: the definition or equation, each symbol coloured by role, with a margin note for any term the reader may not know.
4. **The figure**: the picture of what the statement means, captioned so the caption alone explains it.
5. **The worked example**: the statement applied to the page's numbers, reaching a specific result.
6. **The code**: a short cell that computes the same result, followed by its output.
7. **Check yourself**: one question whose answer is in a collapsed `<details>`.
8. **Watch out**: a pitfall, limit or common confusion, where one exists.

The last section ends with what the concept leads to next, in one or two sentences.

### 4. Make interaction teach

Add interaction only where acting on the page shows something prose cannot:

- **Linking**: give matching elements the same `data-key` (a table cell and its bar, a node and its row) so hovering one highlights both. Use it whenever two figures show the same numbers.
- **A slider** for a parameter whose effect is the point of the section, recomputing figures and readouts from `DATA` live.
- **Toggles** that reveal a step of a derivation or switch between two views of the same data.

Never add motion or controls for decoration.

### 5. Keep every number true

- Figures, tables, readouts and code are computed from `DATA`, so they cannot disagree.
- A code cell's output block shows exactly what running the code prints, in that language's own number formatting (NumPy prints `0.2`, not `0.20`). When the language is available, run the code and paste its real output; otherwise compute the output from `DATA` in `writeCode()`, formatted as the language prints it.
- Probabilities sum to 1, shapes match, and every claim in prose matches the figure.

### 6. Check the page

When a headless browser is available, render the page and look at it:

- at desktop width (about 1400 px) and phone width (390 px, rendered inside a 390 px iframe, since headless browsers keep a minimum window width);
- in light and dark themes;
- confirming the maths rendered (MathJax output has `mjx-container` elements), the figures drew with readable labels, nothing overlaps, and the page has no horizontal scroll at phone width.

Fix what you see before delivering.

### 7. Deliver

- When an Artifact tool is available, publish the page with it, following that tool's own rules (it may require a quickstart call or a design guide first). Artifact pages are wrapped in their own document at publish time, so publish the file without the `<!doctype html>`, `<html>`, `<head>` and `<body>` tags: start with `<title>`, the font `<link>` and `<style>`, then the page, then the scripts. The template already follows the rest of the artifact rules: colour tokens on `:root` with dark-mode overrides and `color-scheme`, scripts only from cdnjs and jsdelivr, a sticky header offset by the safe area, and a copy button that falls back to selecting the code.
- Otherwise write the `.html` file and give its path. It opens directly in a browser.

## Writing voice

- Short paragraphs; one new idea per paragraph.
- Plain words first, then the symbol: "the chance that the previous word is *Hello*", then \(p(W_{t-1} = \text{Hello})\).
- Define every term before using it; a margin note can carry a definition that would interrupt the sentence.
- Concrete numbers over abstractions: say "0.16" rather than "a high probability".
- No filler, no hype, no rhetorical questions in place of explanations.

## Libraries

Load only what the page uses, from these sources:

- MathJax 3, full build (`cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg-full.js`), already in the template. It renders to SVG, needs no stylesheet, and bundles every TeX extension, so it makes no runtime fetches (artifact pages block them).
- highlight.js (`cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js`), already in the template; its colours come from the template's CSS.
- When a figure truly needs more than the template's helpers: D3 or Three.js from cdnjs.

No external stylesheets other than Google Fonts; all other CSS is inline. The template's helpers (`isoBars`, `matrixTable`, `nodeGraph`, `linkKeys`) draw plain SVG and cover most figures without a library.
