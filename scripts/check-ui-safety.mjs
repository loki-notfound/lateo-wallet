#!/usr/bin/env node
/**
 * Static UI security and Svelte 5 Runes enforcement checks:
 * 1. Forbids {@html ...} raw HTML injection in Svelte components.
 * 2. Forbids innerHTML / outerHTML / insertAdjacentHTML / dangerouslySetInnerHTML.
 * 3. Forbids inline style="..." attributes and style: directives in Svelte templates.
 * 4. Forbids legacy Svelte 4 syntax (export let, $: reactive labels, createEventDispatcher,
 *    and <style> blocks inside components if external CSS is enforced or checks emitCss).
 *    Note: <style> in Svelte components is allowed only when Vite compiles with css:"external"
 *    and emits zero runtime <style> injection; here we forbid inline style= attributes and
 *    legacy Svelte 4 directives strictly.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["packages/ui/src", "apps/extension/src"];
const EXTENSIONS = new Set([".svelte", ".ts", ".js", ".html"]);

const RULES = [
  {
    name: "no-raw-html-tag",
    files: [".svelte"],
    pattern: /\{@html\b/g,
    message: "{@html} is forbidden; render untrusted text as text nodes only"
  },
  {
    name: "no-dom-html-sink",
    files: [".svelte", ".ts", ".js"],
    pattern: /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|document\.write)\b/g,
    message: "Direct HTML injection sinks are forbidden"
  },
  {
    name: "no-inline-style-tag",
    files: [".svelte", ".html"],
    pattern: /<style\b/gi,
    message: "<style> tags are forbidden; put all styles in external CSS files"
  },
  {
    name: "no-inline-style-attr",
    files: [".svelte", ".html"],
    pattern: /\bstyle\s*=/gi,
    message: "Inline style= attributes violate strict style-src 'self' CSP discipline"
  },
  {
    name: "no-svelte-style-directive",
    files: [".svelte"],
    pattern: /\bstyle:[a-zA-Z0-9_-]+/g,
    message: "Svelte style: directives mutate inline styles and are forbidden"
  },
  {
    name: "no-svelte4-export-let",
    files: [".svelte"],
    pattern: /\bexport\s+let\b/g,
    message: "Legacy Svelte 4 'export let' is forbidden; use $props() Rune"
  },
  {
    name: "no-svelte4-reactive-label",
    files: [".svelte"],
    pattern: /^\s*\$:\s*/gm,
    message: "Legacy Svelte 4 '$:' reactive statements are forbidden; use $derived/$effect Runes"
  },
  {
    name: "no-svelte4-dispatcher",
    files: [".svelte", ".ts"],
    pattern: /\bcreateEventDispatcher\b/g,
    message: "Legacy Svelte 4 createEventDispatcher is forbidden; pass callback props via $props()"
  },
  {
    name: "no-svelte4-on-directive",
    files: [".svelte"],
    pattern: /\bon:[a-z]+=/g,
    message: "Legacy Svelte 4 'on:event=' directive is forbidden; use Svelte 5 'onevent=' props"
  }
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

let failures = 0;
const files = ROOTS.flatMap((r) => walk(r));

for (const file of files) {
  const ext = path.extname(file);
  const text = fs.readFileSync(file, "utf8");
  for (const rule of RULES) {
    if (!rule.files.includes(ext)) continue;
    rule.pattern.lastIndex = 0;
    let match;
    while ((match = rule.pattern.exec(text)) !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      console.error(`UI-SAFETY [${rule.name}] ${file}:${line} — ${rule.message}`);
      failures++;
    }
  }
}

if (failures > 0) {
  console.error(`check:ui-safety FAILED (${failures} violation(s))`);
  process.exit(1);
}

console.log(`check:ui-safety OK (${files.length} file(s) checked)`);
