/**
 * ONE QUERY GRAMMAR, THE ONE EVERY LLM ALREADY KNOWS (faced#625).
 *
 * Nothing here has to be taught, because it is Google's: bare words rank, quotes mean exactly, and a
 * leading minus excludes. An agent that has never read our documentation still writes a correct query,
 * which is the whole point of a front door.
 *
 * WORDS RANK, THEY DO NOT FILTER, and that is the change this file exists for. Search used to require
 * EVERY word in the same message, so `Hamilton Shivani meeting` returned nothing and a run stopped: no
 * message contains all three words, and none ever would, because the discussion is in those two
 * people's thread and reads "Sorry could we start at 10am PT actually?". Requiring every word answers
 * "nothing matched" when the truth is "not everything matched", and those are different facts.
 *
 * Matching MORE distinct terms simply scores higher. That is what the AND was reaching for, without
 * throwing away the single-word hits that are usually the answer.
 */

/** Lowercase and strip accents, so `rentrée` and `rentree` are the same word. */
export function fold(s: string): string {
	return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface Query {
	/** Optional words. Each one matched raises the score; none is required. */
	terms: string[];
	/** Quoted runs. These must appear contiguously, which is the exact-match escape hatch. */
	phrases: string[];
	/** Words and phrases whose presence removes a hit entirely. */
	excluded: string[];
}

/**
 * Read a query the way a search box does.
 *
 * Quotes first, then minus, then bare words, so `-"exactly this"` excludes a phrase rather than
 * leaving a stray quote in a term.
 */
export function parseQuery(raw: string): Query {
	const terms: string[] = [];
	const phrases: string[] = [];
	const excluded: string[] = [];
	let rest = raw ?? "";

	// Quoted runs, optionally negated: -"a b c" or "a b c"
	rest = rest.replace(/(-?)"([^"]*)"|(-?)'([^']*)'/g, (_m, negA, a, negB, b) => {
		const phrase = fold((a ?? b ?? "").trim());
		if (phrase) (negA || negB ? excluded : phrases).push(phrase);
		return " ";
	});
	for (const word of rest.split(/\s+/)) {
		const w = word.trim();
		if (!w) continue;
		// `OR` and `AND` spelled out are OPERATORS in the dialect models write, not words to look for.
		// Bare words are already or-ish and ranked, so both are no-ops; searching for the letters "or"
		// would match half the corpus and drown the real terms. Watched a run write
		// `"Rob Therrien" OR "robstours@yahoo.ca"` and find nothing.
		if (w === "OR" || w === "AND") continue;
		if (w.startsWith("-") && w.length > 1) {
			const t = fold(w.slice(1));
			if (t) excluded.push(t);
			continue;
		}
		const t = fold(w);
		if (t) terms.push(t);
	}
	return { terms, phrases, excluded };
}

/** Whether a query asks for anything at all. An empty one must match NOTHING, never everything. */
export function isEmptyQuery(q: Query): boolean {
	return q.terms.length === 0 && q.phrases.length === 0;
}

/** One searchable part of a record, and how much a hit in it is worth. */
export interface Field {
	text: string;
	/** A hit on WHO something is with outranks a hit in its body: names identify, prose mentions. */
	weight: number;
}

/**
 * How well one record answers the query, and `null` when it does not answer it at all.
 *
 * EXCLUSIONS ARE ABSOLUTE and everything else is a matter of degree. A required phrase that is absent
 * scores nothing, so `"exactly this"` still behaves like an exact search; bare words only add.
 */
export function scoreFields(fields: Field[], q: Query): number | null {
	if (isEmptyQuery(q)) return null;
	const folded = fields.map((f) => ({ hay: fold(f.text), weight: f.weight }));
	for (const bad of q.excluded) {
		if (folded.some((f) => f.hay.includes(bad))) return null;
	}
	let score = 0;
	let matched = 0;
	// A QUOTED PHRASE IS EXACT, NOT MANDATORY. Requiring every phrase made two of them an AND wearing
	// quotes, which is the bug this grammar exists to remove: `"Rob Therrien" OR "robstours@yahoo.ca"`
	// demanded both and found nothing. Quotes say "these words, in this order"; they do not say "and
	// also everything else I typed". A phrase that matches simply scores, and scores heavily, so the
	// single-phrase case still behaves like an exact search: nothing else matching means no hit at all.
	for (const phrase of q.phrases) {
		const best = folded.filter((f) => f.hay.includes(phrase)).map((f) => f.weight).sort((a, b) => b - a)[0];
		if (best === undefined) continue;
		matched += 1;
		score += best * 4;
	}
	for (const term of q.terms) {
		const best = folded.filter((f) => f.hay.includes(term)).map((f) => f.weight).sort((a, b) => b - a)[0];
		if (best === undefined) continue;
		matched += 1;
		score += best;
	}
	// Nothing asked for was found: not an answer.
	if (matched === 0) return null;
	// MATCHING MORE OF WHAT WAS ASKED WINS. Two words beat one, which is what the old AND was reaching
	// for, and a single-word hit is still returned rather than thrown away.
	score += matched * matched;
	return score;
}
