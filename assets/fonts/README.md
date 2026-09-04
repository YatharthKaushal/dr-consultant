# Fonts

Runtime assets, not web assets. Read at server start-up by
`src/modules/clinical/clinical-pdf.renderer.ts` and embedded into every
generated prescription PDF.

(This is **not** `backend/public/fonts`, which is unrelated leftover front-end
material and is served by nothing.)

## `Lohit-Devanagari.ttf`

**Why it is committed.** `pdfkit`'s fourteen built-in fonts (Helvetica, Times,
Courier and their variants) are Type1/AFM faces with a **Latin-1 encoding**.
Handed a Devanagari string they do not raise an error — they emit the wrong
glyphs. A prescription PDF is a clinical and legal document that carries the
patient's name and the doctor's name, and "डॉ. आरती शर्मा" silently rendering
as mojibake is the exact failure this file prevents.

**Why this font.** It is the smallest permissively-licensed face installed that
covers **both** Devanagari and Basic Latin, plus digits and the punctuation the
prescription layout uses. One embedded face therefore renders an English label
and a Hindi name on the same line, with no font switching and no per-run script
detection to get wrong. (Most Noto Devanagari faces carry no Latin letters at
all, which would have traded one mojibake for another.)

Shaping — conjuncts, reordering, matras — is handled by `fontkit`, which
`pdfkit` uses internally and which ships an Indic shaper. No extra dependency.

**Fallback.** If this file is missing at runtime the renderer logs a warning
once and falls back to Helvetica rather than failing the PDF; a prescription
with a mangled name is bad, but no prescription at all is worse. The fallback is
a degradation, not a supported configuration.

| | |
|---|---|
| Version | Lohit Devanagari (Fedora/`lohit-devanagari`) |
| Licence | SIL Open Font License 1.1 — full text in `LICENSE-Lohit-Devanagari.txt` |
| Copyright | 2006 Modular Infotech Pvt Ltd.; 2009 Red Hat, Inc. |
| Upstream | <https://pagure.io/lohit/> |

The OFL permits bundling, embedding and redistribution — including inside the
PDFs this server generates — provided the font is not sold on its own and the
copyright notice travels with it. That notice is the `LICENSE-*.txt` beside
this file; keep them together.

## Adding another face

Adding a script (Bengali, Tamil, Gurmukhi) means either a face covering Latin +
that script, or teaching the renderer to switch fonts per run. Prefer the
former. Put the licence next to the file and add a row above.
