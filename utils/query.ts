/**
 * What a person means when they type words into a search box.
 *
 * THE WHOLE STRING WAS ONE LITERAL BEFORE, and that is not what anybody means. Searching
 * `Shivani Hamilton` matched only messages where those two words sit next to each other in that order,
 * so a thread full of both came back as "No messages found" while `Shivani` alone found four. Caught on
 * a real Mac by a person watching a run go round in circles: the agent searched, got nothing, narrowed,
 * got something, widened, got nothing, and had no way to tell that the tool was answering a different
 * question from the one it asked.
 *
 * So a query is AND OVER ITS WORDS: every word must appear somewhere in the message, in any order and
 * anywhere in the text. `shivani hamilton` means `shivani && hamilton`. That is the rule every search
 * box in the world uses, which is the point: this is the one place a small model does not have to be
 * taught anything, because it already writes queries for search boxes.
 *
 * TWO CONVENTIONS, BOTH THE ORDINARY ONES. Quoting keeps words together as a phrase, and accents fold,
 * so `rentree` finds `rentrée` and `cafe` finds `café`. The second matters more than it looks on a
 * machine whose messages are half French: without it a person has to type the accent to find their own
 * message, which no search box has required for twenty years.
 *
 * Pure, so the rule is tested rather than argued about.
 */

/** Lowercase and strip accents, so `rentrée` and `rentree` are the same word. */
export function fold(s: string): string {
	return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/**
 * The words a query is asking for. Quoted runs stay together as one phrase.
 *
 * Returns [] for an empty query, which callers MUST treat as "search for nothing" rather than
 * "match everything": an accidental empty string should not return somebody's entire message history.
 */
export function queryTerms(raw: string): string[] {
	const terms: string[] = [];
	// Quoted phrases first, then whatever is left over as individual words.
	const rest = raw.replace(/"([^"]*)"|'([^']*)'/g, (_m, a, b) => {
		const phrase = fold((a ?? b ?? "").trim());
		if (phrase) terms.push(phrase);
		return " ";
	});
	for (const word of rest.split(/\s+/)) {
		const t = fold(word.trim());
		if (t) terms.push(t);
	}
	return terms;
}

/** Whether one message satisfies the query: EVERY term present, in any order. */
export function matchesQuery(text: string, terms: string[]): boolean {
	if (!terms.length) return false;
	const hay = fold(text);
	return terms.every((t) => hay.includes(t));
}
