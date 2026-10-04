# Components

Every component below exists in `assets/template.html`: its CSS is in the `<style>` block and its helpers in the script. Paste the markup inside `<main>` and call the helpers from `drawFigures()`.

## Contents

- [Headings and numbering](#headings-and-numbering)
- [Lede](#lede)
- [Notation in prose and maths](#notation-in-prose-and-maths)
- [Margin note](#margin-note)
- [Callouts](#callouts)
- [Figure](#figure)
- [Linked matrix table](#linked-matrix-table)
- [Isometric 3D bars](#isometric-3d-bars)
- [Node diagram](#node-diagram)
- [Custom SVG figure](#custom-svg-figure)
- [Slider and readout](#slider-and-readout)
- [Code cell with output](#code-cell-with-output)
- [Check yourself](#check-yourself)

## Headings and numbering

`h2` for sections, `h3` for subsections. Each needs an `id` (the contents sidebar is built from them) and a `.num` span:

```html
<h2 id="idea"><span class="num">2</span>The idea: a table of chances</h2>
<h3 id="sharpen"><span class="num">2.1</span>Sharpening the table</h3>
```

## Lede

One or two sentences under the title saying what the page answers. Italic and muted.

```html
<p class="lede">A language model has to say how likely a whole sentence is. Start with the smallest sentence that still has order: two words.</p>
```

## Notation in prose and maths

Prose: wrap a symbol or the words naming it in its role class.

```html
the <span class="in">previous word</span> \(\inp{v_i}\) and the <span class="out">next word</span> \(\outp{v_j}\)
```

Maths: inline `\( … \)`, display `\[ … \]`. Role macros: `\inp{}`, `\outp{}`, `\prm{}`, `\fn{}`, `\pr{}`.

```html
\[
\pr{P_{ij}} = \fn{p}\big(\inp{W_{t-1}} = \inp{v_i},\ \outp{W_t} = \outp{v_j}\big)
\]
```

The notation button in the top bar turns every role colour off; the colours are tokens, so nothing else changes.

## Margin note

A definition or aside next to the paragraph it belongs to. Place it immediately before that paragraph. It sits in the right gutter on wide screens and inline on narrow ones.

```html
<aside class="margin">A <span class="term">joint distribution</span> gives the chance of two things happening together.</aside>
```

## Callouts

Four kinds; the label says which:

| Class | Label | Use for |
|---|---|---|
| `callout` | Note | context, a side remark |
| `callout insight` | Insight | the takeaway of a figure or derivation |
| `callout warning` | Watch out | a pitfall, a limit, a common confusion |
| `callout check` | Check yourself | a question with a hidden answer (see below) |

```html
<div class="callout insight"><div class="label">Insight</div>
Every row sums to <span class="pr">0.20</span>, so on its own each word is equally likely to come first.
</div>
```

## Figure

A figure holds one or more drawings side by side in `.fig-row` (they stack on phones) and a caption that explains the figure without the surrounding text. Figures are numbered automatically through `.fig-num`.

```html
<figure>
  <div class="fig-row">
    <svg id="iso" viewBox="0 0 420 300" style="max-height:340px" role="img" aria-label="…"></svg>
    <div id="joint-table" class="scroll-x"></div>
  </div>
  <figcaption><b>Figure <span class="fig-num"></span>.</b> What it shows, and how to read it.</figcaption>
</figure>
```

Give every `<svg>` an `aria-label` describing what it shows.

## Linked matrix table

`matrixTable(host, matrix, rowLabels, colLabels, { rowSums })` draws a matrix with input-coloured row labels and output-coloured column labels. Each cell carries `data-key="i,j"`, so it lights up with the bar or node of the same key. `rowSums: true` adds a dashed Σ column.

```js
matrixTable($('#joint-table'), DATA.joint, DATA.words, DATA.words, { rowSums: true })
```

Wrap the host in `class="scroll-x"` so wide tables scroll inside the page on phones.

## Isometric 3D bars

`isoBars(svgElement, matrix, rowLabels, colLabels, { cell, tallest })` draws a matrix as a 3D bar grid, back to front, with row labels along the front-right edge and column labels along the front-left edge. Each bar has `data-key="i,j"`; it sizes its own view box.

```js
isoBars($('#iso'), DATA.joint, DATA.words, DATA.words)
```

Use it for any non-negative matrix whose shape is the point: joint distributions, attention weights, confusion matrices, histograms over two variables.

## Node diagram

`nodeGraph(svgElement, nodes, edges)` draws circles and arrows: neurons, layers, pipelines, computation graphs. Node colour comes from its `role`, and edge labels default to the parameter colour. A node with a `key` links to table cells or bars with the same `data-key`.

```js
nodeGraph($('#neuron'), [
  { id: 'b', x: 60, y: 30, label: '1', role: 'in' },
  { id: 'x1', x: 60, y: 90, label: 'x1', role: 'in' },
  { id: 'x2', x: 60, y: 150, label: 'x2', role: 'in' },
  { id: 's', x: 250, y: 100, label: 'Σ', role: 'fn', r: 34 },
  { id: 'y', x: 380, y: 100, label: 'y', role: 'out' },
], [
  { from: 'b', to: 's', label: 'b' },
  { from: 'x1', to: 's', label: 'w1' },
  { from: 'x2', to: 's', label: 'w2' },
  { from: 's', to: 'y' },
])
```

The `<svg>` needs an `id` (the arrowhead marker is named after it) and a `viewBox` covering the coordinates used.

## Custom SVG figure

For anything else (axes and curves, vectors, geometric constructions), draw with the `svg(tag, attrs, parent)` helper, reading colours from the tokens so themes and the notation toggle apply:

```js
const tone = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim()
svg('line', { x1: 0, y1: 0, x2: 120, y2: 60, stroke: tone('--prm'), 'stroke-width': 2 }, host)
```

Redraw from `drawFigures()`. The theme and notation toggles call it, so colours read from tokens stay correct.

## Slider and readout

A slider for one parameter; `drawFigures()` reads it and updates figures and readouts.

```html
<div class="controls">
  <label>\(\prm{\tau}\) <input type="range" id="tau" min="0.2" max="4" step="0.1" value="1"> <span class="readout prm" id="tau-out">1.0</span></label>
  <span>p(to, meet) = <span class="readout pr" id="p-to-meet"></span></span>
</div>
```

```js
$('#tau').addEventListener('input', drawFigures)
```

## Code cell with output

A labelled cell, a copy button, and the output block. Fill the code from `DATA` in `writeCode()` so its numbers match the figures. The output must be what the code really prints.

```html
<div class="cell">
  <div class="head"><span>In [1]: bigram.py</span><button class="copy">copy</button></div>
<pre><code class="language-python" id="code-joint"></code></pre>
<pre class="out-block"><code class="nohighlight" id="code-joint-out"></code></pre>
</div>
```

Keep cells short, ideally under 20 lines. Show one idea per cell. The output block keeps `class="nohighlight"`, or highlight.js guesses a language for it and colours plain output.

## Check yourself

A question whose answer stays hidden until asked for:

```html
<div class="callout check"><div class="label">Check yourself</div>
Which pair is most likely, and what is its probability?
<details><summary>Show answer</summary>The pair <span class="in">to</span> → <span class="out">meet</span>, with <span class="pr">0.16</span>.</details>
</div>
```

Ask about something the reader can work out from the page, not trivia.
