import { describe, expect, test } from "bun:test";
import { fold, parseQuery, scoreFields, isEmptyQuery } from "../utils/query";

// WORDS RANK, THEY DO NOT FILTER (faced#625). Search used to require EVERY word in the same message,
// so "Hamilton Shivani meeting" returned nothing and a run stopped. No message contains all three
// words and none ever would: the discussion is in those two people's thread and reads "Sorry could we
// start at 10am PT actually?". Requiring every word answers "nothing matched" when the truth is "not
// everything matched", and those are different facts.
//
// (An earlier version of this file asserted the AND. It was built to a request that was later
// corrected, and the corrected shape is Google's, which is also the one no agent has to be taught.)

const who = (name: string) => ({ text: name, weight: 3 });
const body = (text: string) => ({ text, weight: 1 });

describe("a query is read the way a search box reads it", () => {
	test("bare words are optional and rank", () => {
		const q = parseQuery("hamilton shivani meeting");
		// Their thread, where NEITHER name is written in the message itself.
		const both = scoreFields([who("Hamilton, Shivani Mitra"), body("could we start at 10am")], q);
		const one = scoreFields([who("Shivani Mitra"), body("ok")], q);
		expect(both).not.toBeNull();
		expect(one).not.toBeNull();
		expect(both!).toBeGreaterThan(one!);
	});

	test("a single matching word is still an answer, never discarded", () => {
		expect(scoreFields([who("+1555"), body("saw hamilton today")],
			parseQuery("hamilton shivani meeting"))).not.toBeNull();
	});

	test("who a thread is with counts for more than a passing mention", () => {
		const q = parseQuery("hamilton");
		const isWith = scoreFields([who("Hamilton"), body("ok")], q)!;
		const mentions = scoreFields([who("+1555"), body("hamilton called")], q)!;
		expect(isWith).toBeGreaterThan(mentions);
	});

	test("a quoted phrase is REQUIRED, which is how you ask for exactly something", () => {
		const q = parseQuery(`"start at 10am"`);
		expect(scoreFields([who("x"), body("could we start at 10am actually")], q)).not.toBeNull();
		expect(scoreFields([who("x"), body("start at 11am")], q)).toBeNull();
	});

	test("a minus excludes outright, whatever else matched", () => {
		const q = parseQuery("invoice -paid");
		expect(scoreFields([who("x"), body("the invoice is attached")], q)).not.toBeNull();
		expect(scoreFields([who("x"), body("the invoice is paid")], q)).toBeNull();
	});

	test("accents and case never matter", () => {
		expect(scoreFields([who("x"), body("c'est la rentrée")], parseQuery("rentree"))).not.toBeNull();
		expect(scoreFields([who("x"), body("BONJOUR CAROLINE")], parseQuery("caroline"))).not.toBeNull();
		expect(fold("CAFÉ")).toBe("cafe");
	});

	// An accidental empty query must not hand back somebody's entire message history.
	test("an empty query matches nothing rather than everything", () => {
		expect(isEmptyQuery(parseQuery("   "))).toBe(true);
		expect(scoreFields([who("x"), body("anything at all")], parseQuery(""))).toBeNull();
	});

	test("nothing matching is still nothing", () => {
		expect(scoreFields([who("Free Mobile"), body("your bill is ready")],
			parseQuery("hamilton shivani"))).toBeNull();
	});
});
