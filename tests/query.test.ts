import { describe, expect, test } from "bun:test";
import { fold, matchesQuery, queryTerms } from "../utils/query";

// A person types into a search box. THE WHOLE STRING WAS ONE LITERAL, so "Shivani Hamilton" meant those
// two words adjacent and in that order: a thread full of both answered "No messages found", while
// "Shivani" alone found four. Caught by somebody watching a run search, narrow, widen and get nowhere.
describe("what a person means by a query", () => {
	test("two words means both words, in any order", () => {
		const q = queryTerms("Shivani Hamilton");
		expect(matchesQuery("Shivani can you send the invite so Hamilton is synced?", q)).toBe(true);
		expect(matchesQuery("hamilton said hi to shivani", q)).toBe(true);
	});

	test("and it is AND, not OR: one word short is no match", () => {
		expect(matchesQuery("Nice to see you today Shivani", queryTerms("Shivani Hamilton"))).toBe(false);
	});

	test("adjacency is not required, which is the whole bug", () => {
		expect(matchesQuery("Shivani, David, Troy and Hamilton", queryTerms("shivani hamilton"))).toBe(true);
	});

	test("quoting keeps words together as a phrase", () => {
		expect(matchesQuery("bonne fin de journée", queryTerms('"bonne fin"'))).toBe(true);
		expect(matchesQuery("fin de la bonne journée", queryTerms('"bonne fin"'))).toBe(false);
	});

	// Half this machine's messages are French. Without folding, a person has to type the accent to find
	// their own message, which no search box has required for twenty years.
	test("accents fold both ways", () => {
		expect(matchesQuery("c'est la rentrée", queryTerms("rentree"))).toBe(true);
		expect(matchesQuery("c'est la rentree", queryTerms("rentrée"))).toBe(true);
		expect(fold("CAFÉ")).toBe("cafe");
	});

	test("case never matters", () => {
		expect(matchesQuery("BONJOUR CAROLINE", queryTerms("caroline"))).toBe(true);
	});

	// An accidental empty query must not hand back somebody's entire message history.
	test("an empty query matches nothing rather than everything", () => {
		expect(queryTerms("   ")).toEqual([]);
		expect(matchesQuery("anything at all", queryTerms(""))).toBe(false);
	});
});
