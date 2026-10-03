// JSONC (JSON with comments and trailing commas), the form OpenCode reads its config in.
// Builtins only, and no Sterling imports, so the resolver (sterling-roots.mjs, bundled into
// hooks) and the installer share one parser.

/** JSONC text to a value: comments and trailing commas outside strings removed. Throws on invalid input. */
export function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated /* comment');
      i = end + 1;
    } else if (c === ',' && /^\s*[}\]]/.test(text.slice(i + 1).replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, (m) => m.replace(/\S/g, ' ')))) {
      // a trailing comma (only whitespace or comments before the closing bracket): dropped
    } else out += c;
  }
  return JSON.parse(out);
}
