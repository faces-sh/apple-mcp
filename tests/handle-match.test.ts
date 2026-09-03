import { describe, expect, test } from "bun:test";
import { matchKnownHandles } from "../utils/phone";

// THE COLLISION THIS EXISTS FOR, and it is not hypothetical: both of these handles are on the real
// machine this was found on. "(604) 730-4051" is a Canadian landline. "+336047304051" is a real French
// subscriber, created when a bug parsed the Canadian number against the Mac's own region and sent a
// message to France. Their digits overlap, so neither guessing a country nor plain suffix matching can
// tell them apart: guessing sends to the stranger, suffix matching READS the stranger's thread and
// presents it as yours.
const KNOWN = ["+16046571752", "(604) 730-4051", "+336047304051", "Free Mobile",
	"lindycity@hotmail.com", "+33749287256"];

describe("matching an address against the handles that exist", () => {
	test("nothing is ever returned that is not already in the database", () => {
		for (const q of ["(604) 730-4051", "604-730-4051", "+16046571752", "6046571752"]) {
			const r = matchKnownHandles(q, KNOWN);
			if (r.kind === "ids") for (const id of r.ids) expect(KNOWN).toContain(id);
		}
	});

	test("a number that fits two countries is REFUSED, not guessed", () => {
		// The same national digits under two country codes, which is the real shape of the collision.
		const both = ["+16047304051", "+336047304051"];
		const r = matchKnownHandles("6047304051", both);
		expect(r.kind).toBe("ambiguous");
		expect((r as any).ids.sort()).toEqual(both.sort());
	});

	test("stating the country resolves it", () => {
		const both = ["+16047304051", "+336047304051"];
		expect(matchKnownHandles("+16047304051", both)).toEqual({ kind: "ids", ids: ["+16047304051"] });
		expect(matchKnownHandles("+336047304051", both)).toEqual({ kind: "ids", ids: ["+336047304051"] });
	});

	// The Mac's region must not be able to change the answer. This is the whole bug in one assertion.
	test("the Mac's own region cannot change a match", () => {
		const before = process.env.APPLE_REGION;
		const answers: string[] = [];
		try {
			for (const region of ["FR", "US", "CA", "JP"]) {
				process.env.APPLE_REGION = region;
				answers.push(JSON.stringify(matchKnownHandles("(604) 730-4051", KNOWN)));
			}
		} finally {
			if (before === undefined) delete process.env.APPLE_REGION;
			else process.env.APPLE_REGION = before;
		}
		expect(new Set(answers).size).toBe(1);
		expect(answers[0]).toContain("(604) 730-4051");
		expect(answers[0]).not.toContain("+336047304051");
	});

	test("an email matches case-insensitively and only itself", () => {
		expect(matchKnownHandles("LINDYCITY@hotmail.com", KNOWN))
			.toEqual({ kind: "ids", ids: ["lindycity@hotmail.com"] });
	});

	test("a carrier name is only ever itself", () => {
		expect(matchKnownHandles("Free Mobile", KNOWN)).toEqual({ kind: "ids", ids: ["Free Mobile"] });
	});

	test("a short code is not joined to a real number by a weak suffix", () => {
		expect(matchKnownHandles("4051", ["+16047304051"])).toEqual({ kind: "none" });
	});

	test("an unknown number is none, not an invention", () => {
		expect(matchKnownHandles("+15559999999", KNOWN)).toEqual({ kind: "none" });
	});
});
