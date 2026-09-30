#!/usr/bin/env node
// check-ai-signs.mjs: a baseline scan for the pattern-matchable signs of AI writing
// catalogued in ../references/signs.md. Numbering matches that file.
//
// Usage: node check-ai-signs.mjs [--summary] <file.txt|file.md|file.html|-> ...
//   "-" reads stdin. --summary prints counts per sign instead of the matching sentences.
//
// It is an aid, never a gate: it always exits 0. Judgement signs (1.6-1.8, 2.5, 2.6, 3.6,
// 3.7) are not scanned; the skill covers them with a human read. Node builtins only.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// --- sentence-level signs ----------------------------------------------------------------
// Each entry: [sign number, name, regex sources]. Patterns use word boundaries and match
// case-insensitively; the words come from the "Words to watch" lines in signs.md.
const SENTENCE_SIGNS = [
  ['1.1', 'Undue emphasis on significance, legacy and broader trends', [
    String.raw`\b(?:stands?|serves?) as a (?:testament|reminder)\b`,
    String.raw`\b(?:is|are|was|were) a (?:testament|reminder)\b`,
    String.raw`\btestament to\b`,
    String.raw`\b(?:crucial|pivotal|vital|significant|key) (?:role|moment)\b`,
    String.raw`\b(?:underscor(?:es|ing|ed)|highlights?|highlighting) (?:its|the|their) (?:importance|significance)\b`,
    String.raw`\breflects? (?:the )?broader\b`,
    String.raw`\bsymboli[sz](?:es|ing|ed) (?:its|the|their|an?)\b`,
    String.raw`\b(?:ongoing|enduring|lasting) (?:legacy|significance|importance)\b`,
    String.raw`\bcontributing to the\b`,
    String.raw`\bsetting the stage for\b`,
    String.raw`\b(?:marking|shaping) the\b`,
    String.raw`\b(?:represents?|marks?) a shift\b`,
    String.raw`\bkey turning point\b`,
    String.raw`\bevolving landscape\b`,
    String.raw`\bfocal point\b`,
    String.raw`\bindelible mark\b`,
    String.raw`\bdeeply rooted\b`,
    String.raw`\bhas generated debate about\b`,
    String.raw`\bprompted broader reflection on\b`,
  ]],
  ['1.2', 'Canned emphasis on notability and media coverage', [
    String.raw`\bindependent coverage\b`,
    String.raw`\b(?:local|national) media outlets?\b`,
    String.raw`\btrade publications?\b`,
    String.raw`\b(?:cited|featured|profiled) in\b`,
    String.raw`\bwritten by a leading expert\b`,
    String.raw`\b(?:maintains?|has) an active social media presence\b`,
  ]],
  ['1.3', 'Superficial analysis (trailing participle clauses)', [
    String.raw`,\s+(?:highlighting|underscoring|emphasi[sz]ing|ensuring|reflecting|symboli[sz]ing|contributing to|cultivating|fostering|encompassing|enhancing|showcasing)\b`,
    String.raw`\bvaluable insights?\b`,
    String.raw`\bresonates? with\b`,
  ]],
  ['1.4', 'Promotional, advert or travel-brochure language', [
    String.raw`\bboasts? an?\b`,
    String.raw`\bvibrant\b`,
    String.raw`\brich (?:cultural |natural )?(?:culture|heritage|history|tradition|traditions)\b`,
    String.raw`\bprofound\b`,
    String.raw`\benhancing\b`,
    String.raw`\bshowcasing\b`,
    String.raw`\bexemplif(?:ies|ying)\b`,
    String.raw`\bcommitment to\b`,
    String.raw`\bnatural beauty\b`,
    String.raw`\bnestled\b`,
    String.raw`\bin the heart of\b`,
    String.raw`\bgroundbreaking\b`,
    String.raw`\brenowned\b`,
    String.raw`\bfeaturing\b`,
    String.raw`\bdiverse array\b`,
    String.raw`\bbreathtaking\b`,
    String.raw`\bstunning\b`,
    String.raw`\bworld-class\b`,
    String.raw`\bseamless(?:ly)?\b`,
    String.raw`\bstate-of-the-art\b`,
  ]],
  ['1.5', 'Vague attributions and overgeneralised opinions', [
    String.raw`\bindustry reports\b`,
    String.raw`\bobservers have cited\b`,
    String.raw`\bexperts (?:argue|say|believe|agree)\b`,
    String.raw`\bsome critics argue\b`,
    String.raw`\bseveral sources\b`,
    String.raw`\bstudies show\b`,
    String.raw`\bwidely regarded\b`,
  ]],
  ['2.1', 'AI vocabulary', [
    String.raw`\badditionally\b`,
    String.raw`\bbolstered\b`,
    String.raw`\bcrucial\b`,
    String.raw`\bdelv(?:e|es|ed|ing)\b`,
    String.raw`\bemphasi[sz]ing\b`,
    String.raw`\benduring\b`,
    String.raw`\bgarner(?:s|ed|ing)?\b`,
    String.raw`\bintricate\b`,
    String.raw`\bintricacies\b`,
    String.raw`\binterplay\b`,
    // "key" as an adjective: only before a noun the guide's examples use, so "key" the
    // object ("the API key", "Key Largo") is left alone.
    String.raw`\bkey (?:role|moment|factor|aspect|component|element|player|driver|feature|insight|takeaways?|points?|considerations?|benefits?|differentiators?|strengths?)\b`,
    String.raw`\blandscapes?\b`,
    String.raw`\bmeticulous(?:ly)?\b`,
    String.raw`\bpivotal\b`,
    String.raw`\bunderscor(?:e|es|ed|ing)\b`,
    String.raw`\btapestry\b`,
    String.raw`\btestament\b`,
    String.raw`\bvaluable\b`,
    String.raw`\bvibrant\b`,
    String.raw`\balign(?:s|ed|ing)? with\b`,
    String.raw`\benhance(?:s|d)?\b`,
    String.raw`\bfoster(?:s|ed|ing)?\b`,
    String.raw`\bhighlighting\b`,
    String.raw`\bshowcasing\b`,
    String.raw`\brobust\b`,
    String.raw`\bleverag(?:e|es|ed|ing)\b`,
    String.raw`\bfurthermore\b`,
  ]],
  ['2.2', 'Avoiding "is", "are" and "has"', [
    String.raw`\b(?:serves?|stands?|functions?|operates?) as\b`,
    String.raw`\brepresents\b`,
    String.raw`\bmarks (?:the|a|an)\b`,
    String.raw`\b(?:boasts|features|maintains|offers) (?:an?|the|\d+|several|multiple|numerous|over|more than)\b`,
    String.raw`\brefers to\b`,
    String.raw`\bventured into\b`,
    String.raw`\bbegan (?:his|her|their|its) career as\b`,
  ]],
  ['2.3', 'Vague connection or association', [
    String.raw`\bassociated with\b`,
    String.raw`\bin connection with\b`,
    String.raw`\bconnected to\b`,
  ]],
  ['2.4', 'Negative parallelisms', [
    String.raw`\bnot only\b[^.;!?]*?\bbut\b`,
    String.raw`\bnot (?:just|merely|simply)\b[^.;!?]{1,80}?(?:,|;|\u2014)\s*(?:it's|it is|it was|that's|but)\b`,
    String.raw`\b(?:isn't|is not|wasn't|aren't|it's not|it is not|that's not)\b[^.;!?,]{1,40},\s*(?:it's|it is|it was|but)\b`,
    String.raw`\bnot\s+[\w'-]+(?:\s+[\w'-]+){0,3},\s+but\b`,
    String.raw`\bnot\s+(?:a|an|the)\s+[\w-]+\s+but\s+(?:a|an|the)\b`,
    String.raw`\bno\s+[\w-]+,\s+no\s+[\w-]+,\s+(?:just|only|simply)\b`,
    String.raw`\brather than\b`,
  ]],
  ['4.1', 'Collaborative communication left in', [
    String.raw`\bi hope this helps\b`,
    String.raw`\bcertainly!`,
    String.raw`\bgreat question\b`,
    String.raw`\blet me know if\b`,
    String.raw`\bwould you like me to\b`,
    String.raw`^here(?: is|'s) (?:an?|the)\b`,
    String.raw`\bin this section, we will\b`,
  ]],
  ['4.2', 'Knowledge-cutoff disclaimers and speculation about gaps', [
    String.raw`\bas of my (?:last|latest) (?:update|training|knowledge)\b`,
    String.raw`\bknowledge cutoff\b`,
    String.raw`\bwhile specific details\b`,
    String.raw`\bnot widely (?:documented|disclosed|available|known)\b`,
    String.raw`\bbased on (?:the )?available information\b`,
    String.raw`\bmaintains a low profile\b`,
  ]],
  ['4.3', 'Placeholders', [
    String.raw`\[(?:your|insert|describe|enter|add)\b[^\]]*\](?!\()`,
    String.raw`\bINSERT_[A-Z_]+\b`,
    String.raw`\b\d{4}-XX-XX\b`,
  ]],
  ['5.1', 'Didactic disclaimers', [
    String.raw`\bit(?:'s| is) (?:important|crucial|essential) to (?:note|remember|consider)\b`,
    String.raw`\bit(?:'s| is) worth (?:noting|mentioning)\b`,
    String.raw`\bit should be noted\b`,
    String.raw`\bmay vary\b`,
    String.raw`\bkeep in mind\b`,
  ]],
  ['5.2', 'Section summaries', [
    String.raw`^(?:in summary|in conclusion|overall|ultimately|to sum up|to summari[sz]e)\b`,
  ]],
];

const SENTENCE_RES = SENTENCE_SIGNS.map(([id, name, parts]) => ({ id, name, re: new RegExp(parts.join('|'), 'gi') }));

const DOC_SIGN_NAMES = {
  '3.1': 'Title Case headings',
  '3.2': 'Overuse of boldface',
  '3.3': 'Inline-header vertical lists',
  '3.4': 'Overuse of em dashes',
  '3.5': 'Emoji as formatting',
  '3.8': 'Thematic breaks between sections',
};

const SIGN_ORDER = [...Object.keys(DOC_SIGN_NAMES), ...SENTENCE_SIGNS.map((s) => s[0])]
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const SIGN_NAME = { ...DOC_SIGN_NAMES, ...Object.fromEntries(SENTENCE_SIGNS.map((s) => [s[0], s[1]])) };

const NOT_SCANNED_LINE =
  'Not scanned (judgement signs, read by hand): 1.6-1.8, 2.5, 2.6, 3.6, 3.7. ' +
  'Skipped text: front matter, code fences, inline code, blockquotes, quoted spans, table rows.';

// --- tuning knobs ------------------------------------------------------------------------
const EM_DASH_PER_WORDS = 250; // allowance: one em dash per 250 words, so a long piece may keep a couple
const BOLD_MIN_SPANS = 5;
const BOLD_WORDS_PER_SPAN = 50; // flag when bold spans are denser than one per 50 words
const THEMATIC_BREAK_MIN = 2;
const QUOTE_SPAN_MAX = 300;

// --- text preparation ----------------------------------------------------------------------
const ENTITIES = { '&mdash;': '—', '&#8212;': '—', '&#x2014;': '—', '&amp;': '&', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&lt;': '<', '&gt;': '>', '&rsquo;': "'", '&lsquo;': "'", '&ldquo;': '"', '&rdquo;': '"' };

function htmlToMarkdownish(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|pre|code|blockquote)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inner.replace(/\s+/g, ' ').trim()}\n\n`)
    .replace(/<hr\b[^>]*>/gi, '\n\n---\n\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(?:strong|b)\b[^>]*>/gi, '**')
    .replace(/<\/?(?:p|div|section|article|ul|ol|li|br|tr|table|header|footer|main|figure)\b[^>]*>/gi, '\n')
    .replace(/<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?\/?>/gi, '')
    .replace(/&(?:mdash|amp|nbsp|quot|lt|gt|rsquo|lsquo|ldquo|rdquo|#8212|#x2014|#39);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function stripFrontMatter(lines) {
  if (lines[0]?.trim() !== '---') return lines;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end === -1 ? lines : lines.map((l, i) => (i <= end ? '' : l));
}

/** Blank out fenced code, blockquote lines and table rows, keeping line structure. */
function dropSkippedLines(lines) {
  let fence = null;
  return lines.map((line) => {
    const f = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
      return '';
    }
    if (f) { fence = f[1]; return ''; }
    if (/^\s{0,3}>/.test(line) || /^\s*\|/.test(line)) return '';
    return line;
  });
}

const LIST_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING_RE = /^\s{0,3}#{1,6}\s+/;
const BREAK_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;

function buildBlocks(lines) {
  const blocks = [];
  let para = null;
  let lastList = null;
  const flush = () => { para = null; };
  for (const raw of lines) {
    if (!raw.trim()) { flush(); lastList = null; continue; }
    if (BREAK_RE.test(raw)) { flush(); lastList = null; blocks.push({ kind: 'break', raw }); continue; }
    if (HEADING_RE.test(raw)) { flush(); lastList = null; blocks.push({ kind: 'heading', raw }); continue; }
    if (LIST_RE.test(raw)) { flush(); lastList = { kind: 'list', raw }; blocks.push(lastList); continue; }
    if (lastList && /^\s{2,}/.test(raw)) { lastList.raw += ` ${raw.trim()}`; continue; }
    if (!para) { para = { kind: 'para', raw: raw.trim() }; blocks.push(para); lastList = null; } else para.raw += ` ${raw.trim()}`;
  }
  return blocks;
}

/** Mask inline code and quoted spans, turn links into their text, normalise quotes. */
function maskInline(raw) {
  return raw
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '[$1]')
    .replace(new RegExp(`"[^"]{1,${QUOTE_SPAN_MAX}}"`, 'g'), ' ');
}

function stripMarkers(s) {
  return s
    .replace(/^\s*(?:#{1,6}|[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__/g, '')
    .replace(/(?<![\w*])\*(?=\S)|(?<=\S)\*(?![\w*])/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ABBR_RE = /\b(?:e\.g|i\.e|etc|vs|cf|approx|Mr|Mrs|Ms|Dr|St|No|Fig|U\.S|U\.K)\./gi;

function splitSentences(text) {
  const protectedText = text.replace(ABBR_RE, (m) => m.replace(/\./g, '\u0001'));
  return protectedText
    .split(/(?<=[.!?…]["')\]]?)\s+(?=[A-Z0-9"'(\[])/)
    .map((s) => s.replace(/\u0001/g, '.').trim())
    .filter(Boolean);
}

function isTitleCase(heading) {
  const words = heading.replace(/[^A-Za-z' -]/g, ' ').split(/\s+/).filter((w) => w.length >= 4);
  return words.length >= 3 && words.every((w) => /^[A-Z]/.test(w));
}

const EMOJI_RE = /(?![©®™←-⇿])\p{Extended_Pictographic}/gu;
const truncate = (s, n = 200) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

// --- scan -------------------------------------------------------------------------------------
/** Returns { words, sentences, findings: Map<sign, {count, items[]}> } for one text. */
export function scanText(input) {
  const text = htmlToMarkdownish(input.replace(/\r\n?/g, '\n'));
  const blocks = buildBlocks(dropSkippedLines(stripFrontMatter(text.split('\n'))));
  const findings = new Map();
  const add = (sign, item, count = 1) => {
    const f = findings.get(sign) ?? { count: 0, items: [] };
    f.count += count;
    if (item) f.items.push(item);
    findings.set(sign, f);
  };

  let words = 0;
  let sentenceCount = 0;
  let boldSpans = 0;
  let emDashes = 0;
  const emDashSentences = [];
  const breaks = blocks.filter((b) => b.kind === 'break').length;
  const labelBullets = [];

  for (const block of blocks) {
    if (block.kind === 'break') continue;
    const masked = maskInline(block.raw);
    // A bold lead-in that opens a list item is a label, not bold running prose; 3.3 covers
    // the "**Label:**" form, so those spans stay out of the 3.2 density.
    const proseBold = block.kind === 'list' ? masked.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)(?:\*\*[^*\n]+\*\*|__[^_\n]+__)/, '$1') : masked;
    boldSpans += (proseBold.match(/\*\*[^*\n]+\*\*|__[^_\n]+__/g) ?? []).length;
    if (block.kind === 'list' && /^\s*(?:[-*+]|\d+[.)])\s+(?:\*\*[^*\n]+:\*\*|__[^_\n]+:__)/.test(masked)) {
      labelBullets.push(truncate(stripMarkers(masked)));
    }
    const clean = stripMarkers(masked);
    if (block.kind === 'heading' && isTitleCase(clean)) add('3.1', truncate(clean));
    const emoji = clean.match(EMOJI_RE);
    if (emoji) add('3.5', `${truncate(clean)}  [${emoji.join(' ')}]`, emoji.length);
    words += clean.split(/\s+/).filter(Boolean).length;

    for (const sentence of splitSentences(clean)) {
      sentenceCount += 1;
      const dashes = (sentence.match(/—/g) ?? []).length;
      if (dashes) { emDashes += dashes; emDashSentences.push(truncate(sentence)); }
      for (const { id, re } of SENTENCE_RES) {
        re.lastIndex = 0;
        const hits = [...sentence.matchAll(re)].map((m) => m[0].trim());
        if (hits.length) add(id, `${truncate(sentence)}  [${[...new Set(hits.map((h) => h.toLowerCase()))].join(' | ')}]`);
      }
    }
  }

  if (boldSpans >= BOLD_MIN_SPANS && words / boldSpans < BOLD_WORDS_PER_SPAN) {
    add('3.2', `${boldSpans} bold spans in ${words} words (flagged above one per ${BOLD_WORDS_PER_SPAN} words)`, boldSpans);
  }
  for (const b of labelBullets) add('3.3', b);
  const allowed = Math.floor(words / EM_DASH_PER_WORDS);
  if (emDashes > allowed) {
    add('3.4', `${emDashes} em dash(es) in ${words} words (allowance ${allowed}); sentences:`, emDashes);
    for (const s of emDashSentences) findings.get('3.4').items.push(s);
  }
  if (breaks >= THEMATIC_BREAK_MIN) add('3.8', `${breaks} thematic breaks (---) in ${words} words`, breaks);
  return { words, sentences: sentenceCount, findings };
}

// --- reporting ----------------------------------------------------------------------------------
function report(label, result, summary, out) {
  out.push(`== ${label} (${result.words} words, ${result.sentences} sentences)`);
  let total = 0;
  for (const sign of SIGN_ORDER) {
    const f = result.findings.get(sign);
    if (!f) continue;
    total += f.count;
    out.push(summary ? `${sign}  ${String(f.count).padStart(3)}  ${SIGN_NAME[sign]}` : `${sign} ${SIGN_NAME[sign]} (${f.count})`);
    if (!summary) for (const item of f.items) out.push(`  - ${item}`);
  }
  out.push(total ? `${total} hit(s).` : 'No pattern-matchable signs found.');
}

function main(argv) {
  const summary = argv.includes('--summary');
  const targets = argv.filter((a) => a !== '--summary');
  const out = [];
  if (!targets.length) {
    console.log('usage: node check-ai-signs.mjs [--summary] <file.txt|file.md|file.html|-> ...');
    console.log(NOT_SCANNED_LINE);
    return;
  }
  const totals = new Map();
  for (const t of targets) {
    let content;
    try {
      content = readFileSync(t === '-' ? 0 : t, 'utf8');
    } catch (err) {
      console.error(`check-ai-signs: cannot read ${t}: ${err.message}`);
      continue;
    }
    const result = scanText(content);
    report(t === '-' ? '(stdin)' : t, result, summary, out);
    for (const [sign, f] of result.findings) totals.set(sign, (totals.get(sign) ?? 0) + f.count);
  }
  if (summary && targets.length > 1) {
    out.push('== TOTAL');
    for (const sign of SIGN_ORDER) if (totals.has(sign)) out.push(`${sign}  ${String(totals.get(sign)).padStart(3)}  ${SIGN_NAME[sign]}`);
  }
  out.push(NOT_SCANNED_LINE);
  console.log(out.join('\n'));
}

// Run as a CLI only when executed directly, so tests can import scanText.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
