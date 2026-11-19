/**
 * @file richDoc - a written document with its design, as the server keeps it
 * @module utils/richDoc
 *
 * Eden (2026-11-19): templates "כמו מיני docs באפליקציה" - colour, font,
 * size, indents, underline, markers. The document is NOT kept as HTML: it
 * is a small tree (the editor's own JSON - client/src/components/Rich) of a
 * few known blocks and marks, and every design choice is a NAME from a
 * short list ("blue", "lg", "hand"), never a free value. So nothing a
 * browser would run can be stored, the reader draws it with its own
 * elements, and a colour reads in the light theme and in the dark one.
 *
 *   doc            → block+
 *   paragraph      { align: center | left, indent: 1..6 } → text / hard_break
 *   bullet_list, ordered_list → list_item+
 *   list_item      → paragraph, then blocks
 *   horizontal_rule
 *   text           marks: bold · italic · underline · strike ·
 *                  color{v} · mark{v} · size{v} · font{v}
 *
 * `cleanDoc` returns the tree with everything unknown dropped (or throws
 * DOC_INVALID when it is no document at all, or far too large);
 * `textOf` is the same document as plain lines - what the lists preview,
 * what a search reads, what an older reader of `body` shows.
 *
 * The lists here and in client/src/lib/richDoc.js must agree.
 */

const AppError = require("./AppError");

const COLORS = ["red", "orange", "yellow", "green", "aqua", "blue", "violet", "magenta", "gray"];
const MARKERS = ["yellow", "green", "aqua", "blue", "pink", "orange", "purple"];
const SIZES = ["sm", "lg", "xl"];
const FONTS = ["hand", "serif"];
const ALIGNS = ["center", "left"];
const MAX_INDENT = 6;

const PLAIN_MARKS = ["bold", "italic", "underline", "strike"];
const VALUE_MARKS = { color: COLORS, mark: MARKERS, size: SIZES, font: FONTS };

const MAX_NODES = 6000;
const MAX_CHARS = 60000;
const MAX_DEPTH = 12;

const emptyDoc = () => ({ type: "doc", content: [{ type: "paragraph" }] });

function cleanMarks(marks) {
  if (!Array.isArray(marks)) return undefined;
  const out = [];
  const seen = new Set();
  for (const m of marks) {
    const type = m && typeof m === "object" ? m.type : null;
    if (!type || seen.has(type)) continue;
    if (PLAIN_MARKS.includes(type)) {
      seen.add(type);
      out.push({ type });
    } else if (VALUE_MARKS[type]) {
      const v = m.attrs && typeof m.attrs === "object" ? m.attrs.v : null;
      if (!VALUE_MARKS[type].includes(v)) continue;
      seen.add(type);
      out.push({ type, attrs: { v } });
    }
  }
  return out.length ? out : undefined;
}

/** The tree, checked - unknown blocks, marks and values are dropped. */
function cleanDoc(raw) {
  if (!raw || typeof raw !== "object" || raw.type !== "doc" || !Array.isArray(raw.content)) throw AppError.of("DOC_INVALID", 400);
  const count = { nodes: 0, chars: 0 };
  const tick = () => {
    if (++count.nodes > MAX_NODES) throw AppError.of("DOC_TOO_LONG", 400);
  };

  const inline = (list) => {
    const out = [];
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "text") {
        // eslint-disable-next-line no-control-regex
        const text = typeof n.text === "string" ? n.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") : "";
        if (!text) continue;
        tick();
        count.chars += text.length;
        if (count.chars > MAX_CHARS) throw AppError.of("DOC_TOO_LONG", 400);
        const marks = cleanMarks(n.marks);
        out.push(marks ? { type: "text", text, marks } : { type: "text", text });
      } else if (n.type === "hard_break") {
        tick();
        out.push({ type: "hard_break" });
      }
    }
    return out;
  };

  const paragraph = (n) => {
    tick();
    const attrs = {};
    const a = n.attrs && typeof n.attrs === "object" ? n.attrs : {};
    if (ALIGNS.includes(a.align)) attrs.align = a.align;
    const indent = Math.floor(Number(a.indent));
    if (indent >= 1) attrs.indent = Math.min(indent, MAX_INDENT);
    const content = inline(n.content);
    const out = { type: "paragraph" };
    if (Object.keys(attrs).length) out.attrs = attrs;
    if (content.length) out.content = content;
    return out;
  };

  const blocks = (list, depth) => {
    if (depth > MAX_DEPTH) return [];
    const out = [];
    for (const n of Array.isArray(list) ? list : []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "paragraph") out.push(paragraph(n));
      else if (n.type === "horizontal_rule") {
        tick();
        out.push({ type: "horizontal_rule" });
      } else if (n.type === "bullet_list" || n.type === "ordered_list") {
        const items = [];
        for (const li of Array.isArray(n.content) ? n.content : []) {
          if (!li || typeof li !== "object" || li.type !== "list_item") continue;
          tick();
          const inner = blocks(li.content, depth + 1);
          // an item opens with a paragraph - the editor's own rule
          if (!inner.length || inner[0].type !== "paragraph") inner.unshift({ type: "paragraph" });
          items.push({ type: "list_item", content: inner });
        }
        if (!items.length) continue;
        tick();
        out.push({ type: n.type, content: items });
      }
    }
    return out;
  };

  const content = blocks(raw.content, 0);
  return { type: "doc", content: content.length ? content : [{ type: "paragraph" }] };
}

/** The document as plain lines (lists keep their marks, an indent its room). */
function textOf(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.content)) return "";
  const lines = [];
  const line = (n) => (n.content || []).map((c) => (c.type === "text" ? c.text : c.type === "hard_break" ? "\n" : "")).join("");
  const walk = (list, pad) => {
    for (const n of list || []) {
      if (n.type === "paragraph") lines.push(pad + line(n));
      else if (n.type === "horizontal_rule") lines.push("");
      else if (n.type === "bullet_list" || n.type === "ordered_list") {
        (n.content || []).forEach((li, i) => {
          const [first, ...rest] = li.content || [];
          const lead = n.type === "ordered_list" ? `${i + 1}. ` : "• ";
          lines.push(pad + lead + (first && first.type === "paragraph" ? line(first) : ""));
          walk(first && first.type === "paragraph" ? rest : li.content, pad + "   ");
        });
      }
    }
  };
  walk(doc.content, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Nothing written in it (design alone is not content). */
const isEmptyDoc = (doc) => !textOf(doc);

/** Plain text as a document - one paragraph a line. */
function docFromText(text) {
  const rows = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  return { type: "doc", content: rows.map((t) => (t ? { type: "paragraph", content: [{ type: "text", text: t }] } : { type: "paragraph" })) };
}

module.exports = { cleanDoc, textOf, isEmptyDoc, docFromText, emptyDoc, COLORS, MARKERS, SIZES, FONTS, ALIGNS, MAX_INDENT };
