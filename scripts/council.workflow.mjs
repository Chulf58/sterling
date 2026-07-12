export const meta = {
  name: 'council',
  description: 'Six-hats pre-build deliberation: 3 bounded rounds (blind → rebut → converge) + blue synthesis',
  phases: [
    { title: 'Round 1 — blind', detail: '5 hats in parallel, KB articles first then code, no cross-talk', model: 'opus' },
    { title: 'Round 2 — rebut', detail: '5 hats see the full Round-1 transcript', model: 'opus' },
    { title: 'Round 3 — converge', detail: '5 hats see the full Round-2 transcript', model: 'opus' },
    { title: 'Synthesis', detail: 'blue organizes the three rounds into the interview agenda', model: 'opus' },
  ],
}

// Council — six-hats pre-build deliberation (SOP: skills/council/SKILL.md).
// Sterling's first Workflow-tool script. Hats are EPHEMERAL prompts riding the
// registered read-only explorer agent (Read/Grep/Glob + knowledge_query/
// knowledge_get; no Bash, no Edit/Write) — never roster members; invariant 3
// does not bind them (same category as the platform's unregistered agents).
// The deliberation is TRANSIENT: nothing here writes to the store; a decision
// is captured downstream only on explicit user commitment. All agents ride the
// platform 'opus' alias — the Workflow tool's model enum has no exact-pin form
// (a127e6e1 governs the build roster's config/frontmatter, not this seam).
// The two barriers between rounds are the deliberation itself: every hat must
// see ALL of the prior round before speaking again.

// the harness may deliver args as a JSON-encoded string (observed live 2026-07-05) — tolerate both
const input = typeof args === 'string' ? JSON.parse(args) : (args ?? {})
const { idea, answers_so_far = '(none provided)', scope = '', stack_tags = [] } = input
if (!idea || typeof idea !== 'string') {
  throw new Error("council: args.idea (the user's verbatim idea) is required — never run the council on a paraphrase")
}

const HATS = [
  { color: 'white', emoji: '⚪', concern: 'facts — what we verifiably know, and where the data gaps are', retrieval: 'research findings, decisions, and feature articles for established facts; code for ground truth' },
  { color: 'red', emoji: '🔴', concern: 'gut / intuition — the sanctioned hunch channel, always labeled intuition', retrieval: null },
  { color: 'yellow', emoji: '🟡', concern: 'value — why this could work and what it wins', retrieval: 'feature articles for prior wins and adjacent capabilities; code for seams it could ride' },
  { color: 'black', emoji: '⚫', concern: 'risks — flaws, failure modes, what breaks', retrieval: 'anti_patterns and known_gaps for past failures; code for real feasibility limits' },
  { color: 'green', emoji: '🟢', concern: 'alternatives — other ways to get the same value', retrieval: "decisions' alternatives_rejected for roads already weighed; code for existing patterns that already solve it" },
]

const HAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['color', 'position', 'cited_record_ids', 'cited_files', 'research_needed'],
  properties: {
    color: { type: 'string', description: 'your hat color' },
    position: { type: 'string', description: 'your deliberation for this round, from your concern alone' },
    cited_record_ids: { type: 'array', items: { type: 'string' }, description: 'knowledge-record UUIDs you actually relied on (empty for the red hat)' },
    cited_files: { type: 'array', items: { type: 'string' }, description: 'repo-relative file paths you actually relied on (empty for the red hat)' },
    research_needed: { type: 'array', items: { type: 'string' }, description: 'external/web questions you could not answer from KB+code — surfaced, never chased' },
  },
}

const COUNCIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'hat_positions', 'interview_agenda', 'top_risks', 'best_alternative', 'red_hunch', 'research_questions', 'advisory_lean', 'confidence'],
  properties: {
    summary: { type: 'string', description: 'the deliberation in a short paragraph' },
    hat_positions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['color', 'final_position'],
        properties: { color: { type: 'string' }, final_position: { type: 'string' } },
      },
    },
    interview_agenda: {
      type: 'array',
      description: 'the question queue for the next intake pass — the conductor drains it ONE question at a time',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['question', 'source_hat', 'kind'],
        properties: {
          question: { type: 'string' },
          source_hat: { type: 'string' },
          kind: { type: 'string', enum: ['keep_or_solve', 'consider_alternative', 'fact_finding', 'open'] },
        },
      },
    },
    top_risks: { type: 'array', items: { type: 'string' }, description: "black's strongest risks" },
    best_alternative: { type: 'string', description: "green's strongest alternative (or 'none' when the asked path wins)" },
    red_hunch: { type: 'string', description: "red's gut read — ALWAYS presented as intuition, never fact" },
    research_questions: { type: 'array', items: { type: 'string' }, description: "union of the hats' research_needed — route to the grill's bounded researcher trigger" },
    advisory_lean: { type: 'string', enum: ['go', 'refine', 'drop', 'needs-more-info'], description: 'advisory colour, never a gate' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
}

const CONTEXT = [
  'THE IDEA (verbatim, from the user):',
  idea,
  '',
  'ANSWERS SO FAR (prior intake passes, verbatim Q&A):',
  answers_so_far,
  scope ? `\nSCOPE HINT: ${scope}` : '',
  stack_tags.length ? `STACK TAGS: ${stack_tags.join(', ')}` : '',
].join('\n')

function preamble(hat, roundName) {
  const lines = [
    `You are the ${hat.emoji} ${hat.color.toUpperCase()} hat on Sterling's council — a six-hats pre-build deliberation on an idea that is NOT yet built. Your single concern: ${hat.concern}.`,
    `This is the ${roundName} round of three (blind → rebut → converge); a blue synthesis follows. Stay strictly on your own concern — the other hats cover the rest.`,
    '',
    'GROUND RULES:',
    '- READ-ONLY, TRANSIENT: never create, update, or remove any record or file. Do NOT call handoff_write or agent_exit — no pipeline run is active and they will be refused; your structured output is your only deliverable.',
    '- If answering well would need EXTERNAL/web research: do not guess, do not chase it — surface the question in research_needed.',
  ]
  if (hat.retrieval) {
    lines.splice(4, 0, `- Retrieval-first: query the knowledge base BEFORE reading code — knowledge_query (rank_terms are single keywords; articles first), knowledge_get for detail; consult ${hat.retrieval}. Then read the codebase (Read/Grep/Glob) where your concern needs ground truth. Cite ONLY record ids and file paths you actually relied on.`)
  } else {
    lines.splice(4, 0, '- You are the sanctioned intuition channel: give your gut read, ALWAYS labeled as intuition, never as fact. You need not retrieve or cite (empty citation arrays are expected of you).')
  }
  return lines.join('\n')
}

function transcript(round) {
  return round
    .map((h) =>
      [
        `--- ${h.color} ---`,
        h.position,
        `(cited records: ${h.cited_record_ids.join(', ') || '—'} | cited files: ${h.cited_files.join(', ') || '—'} | research surfaced: ${h.research_needed.join(' ; ') || '—'})`,
      ].join('\n')
    )
    .join('\n\n')
}

const blindPrompt = (hat) =>
  [preamble(hat, 'BLIND'), '', CONTEXT, '', 'TASK: deliberate from your concern alone. You cannot see the other hats this round — do not guess what they will say. Be concrete and grounded; name the sharpest things your concern reveals about this idea.'].join('\n')

const rebutPrompt = (hat, r1) =>
  [preamble(hat, 'REBUT'), '', CONTEXT, '', 'ROUND 1 TRANSCRIPT (all five hats, verbatim):', transcript(r1), '', 'TASK: engage the OTHER hats’ round-1 positions from your concern — rebut what your concern says is wrong, reinforce what it says is right, refine your own position where they exposed a gap. New retrieval is allowed where it sharpens the engagement.'].join('\n')

const convergePrompt = (hat, r2) =>
  [preamble(hat, 'CONVERGE'), '', CONTEXT, '', 'ROUND 2 TRANSCRIPT (all five hats, verbatim):', transcript(r2), '', 'TASK: converge. State your FINAL position and, concretely, what the intake interview must still ask or resolve before this idea is built — those become the agenda.'].join('\n')

const synthPrompt = (r1, r2, r3) =>
  [
    'You are the 🔵 BLUE hat — the synthesis — of Sterling’s council. You NEVER debate the topic; you organize what the five deliberating hats said across three rounds into the structured output. Use no tools; work only from the transcripts.',
    '',
    CONTEXT,
    '',
    'ROUND 1 (blind):',
    transcript(r1),
    '',
    'ROUND 2 (rebut):',
    transcript(r2),
    '',
    'ROUND 3 (converge):',
    transcript(r3),
    '',
    'TASK: produce the council output. interview_agenda = the questions the intake interview should ask next, deduplicated, sharpest first, each attributed to its source hat and kinded (keep_or_solve | consider_alternative | fact_finding | open). top_risks from black; best_alternative from green; red_hunch from red — phrase it explicitly as intuition. research_questions = the union of research_needed across rounds. advisory_lean is advisory colour, never a gate.',
  ].join('\n')

const hatOpts = (hat, phaseTitle, tag) => ({
  schema: HAT_SCHEMA,
  model: 'opus',
  agentType: 'explorer',
  label: `${tag}:${hat.color}`,
  phase: phaseTitle,
})

// Partial-hat failure is a QUALITY signal, not just a >0 gate (audit finding
// 37/43): a round where most hats fail (e.g. black — the risks voice — never
// speaks) proceeds on a minority, and the synthesis reads as full-council. Track
// which colors reported each round (parallel preserves HATS order, so a null at
// index i = that hat failed), and mark the result degraded when a round drops
// below the quorum. Below quorum on ALL surviving-but-thin rounds is not fatal,
// but the caller must be able to see it.
const MIN_HATS_QUORUM = 3
const survivors = (raw) => HATS.filter((_, i) => raw[i]).map((h) => h.color)

phase('Round 1 — blind')
const r1raw = await parallel(HATS.map((h) => () => agent(blindPrompt(h), hatOpts(h, 'Round 1 — blind', 'r1'))))
const r1 = r1raw.filter(Boolean)
const r1colors = survivors(r1raw)
if (r1.length === 0) throw new Error('council: round 1 produced no hat output — aborting rather than deliberating on silence (P5)')
log(`round 1 complete — ${r1.length}/5 hats (${r1colors.join(', ')})`)

phase('Round 2 — rebut')
const r2raw = await parallel(HATS.map((h) => () => agent(rebutPrompt(h, r1), hatOpts(h, 'Round 2 — rebut', 'r2'))))
const r2 = r2raw.filter(Boolean)
const r2colors = survivors(r2raw)
if (r2.length === 0) throw new Error('council: round 2 produced no hat output — the deliberation collapsed mid-way; aborting (P5)')
log(`round 2 complete — ${r2.length}/5 hats (${r2colors.join(', ')})`)

phase('Round 3 — converge')
const r3raw = await parallel(HATS.map((h) => () => agent(convergePrompt(h, r2), hatOpts(h, 'Round 3 — converge', 'r3'))))
const r3 = r3raw.filter(Boolean)
const r3colors = survivors(r3raw)
if (r3.length === 0) throw new Error('council: round 3 produced no hat output — the deliberation collapsed mid-way; aborting (P5)')
log(`round 3 complete — ${r3.length}/5 hats (${r3colors.join(', ')})`)

phase('Synthesis')
// blue rides the read-only explorer type too — transience is structural for all
// six voices, not prompt-only for the synthesis (reviewer-correctness 2026-07-05)
const council = await agent(synthPrompt(r1, r2, r3), { schema: COUNCIL_SCHEMA, model: 'opus', agentType: 'explorer', label: 'blue', phase: 'Synthesis' })
if (!council) throw new Error('council: blue synthesis returned nothing — the deliberation is lost; re-run (P5)')

// Deterministic, script-computed participation trail so a thinned deliberation
// can never silently pose as full-council (finding 37/43).
const participation = { r1: r1colors, r2: r2colors, r3: r3colors }
const thinnest = Math.min(r1.length, r2.length, r3.length)
const degraded = thinnest < MIN_HATS_QUORUM
const missing_voices = HATS.map((h) => h.color).filter((c) => !(r1colors.includes(c) && r2colors.includes(c) && r3colors.includes(c)))
if (degraded) log(`council DEGRADED — thinnest round had ${thinnest}/${HATS.length} hats (quorum ${MIN_HATS_QUORUM}); missing across rounds: ${missing_voices.join(', ') || 'none'}`)

return { ...council, participation, degraded, missing_voices }
