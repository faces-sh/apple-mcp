import { describe, expect, test } from "bun:test";
import { isBookkeeping, typedstreamStrings, typedstreamText } from "../utils/typedstream";

/** Build a typedstream string record the way Messages writes one: `+`, length, then UTF-8 bytes. */
function record(text: string): Buffer {
	const body = Buffer.from(text, "utf8");
	if (body.length < 0x80) return Buffer.concat([Buffer.from([0x2b, body.length]), body]);
	const len = Buffer.alloc(2);
	len.writeUInt16LE(body.length);
	return Buffer.concat([Buffer.from([0x2b, 0x81]), len, body]);
}

const HEADER = Buffer.from("streamtyped", "utf8");

describe("reading an attributedBody", () => {
	test("reads the message a person actually wrote", () => {
		const blob = Buffer.concat([HEADER, record("Salut, on arrive la semaine prochaine")]);
		expect(typedstreamText(blob)).toBe("Salut, on arrive la semaine prochaine");
	});

	// THE BUG THIS REPLACES. The old decoder read the binary as UTF-8 text and regex-matched XML that is
	// not there, so a real message came back as `https://s.sumup.com/77ojrn_q<?>iI/<?><?>`. It knew the
	// artefact well enough to strip a trailing "iI K" by hand.
	test("does not leave the binary framing in the text", () => {
		const blob = Buffer.concat([HEADER, record("https://s.sumup.com/77ojrn_q")]);
		const text = typedstreamText(blob)!;
		expect(text).toBe("https://s.sumup.com/77ojrn_q");
		expect(text).not.toContain("iI");
		expect(text).not.toContain("�");
	});

	// ACCENTS SURVIVE, which is the whole point for a French reply: a byte-wise read splits them.
	test("keeps accented and non-latin text intact", () => {
		for (const said of ["à demain, c'est la rentrée", "ça va ?", "见面吧", "🙂 ok"]) {
			expect(typedstreamText(Buffer.concat([HEADER, record(said)]))).toBe(said);
		}
	});

	// A long message uses the two-byte length form, which the old reader had no notion of at all.
	test("reads a message past the one-byte length", () => {
		const long = "z".repeat(400);
		expect(typedstreamText(Buffer.concat([HEADER, record(long)]))).toBe(long);
	});

	// AN AUDIO MESSAGE'S TRANSCRIPT is the text, and it arrives surrounded by attribute names and a
	// transfer id. Reading the first string returns an attribute name; rejecting them all drops the
	// transcript. Both were real failures in the Python reader this is ported from.
	test("finds a transcript among the archive's own words", () => {
		const blob = Buffer.concat([
			HEADER,
			record("__kIMFileTransferGUIDAttributeName"),
			record("at_0_82F848B5-4D8C-4271-9226-F24FDA501B95"),
			record("I'll be there at six"),
			record("__kIMBaseWritingDirectionAttributeName"),
		]);
		expect(typedstreamText(blob)).toBe("I'll be there at six");
	});

	test("knows the archive's own words from a person's", () => {
		for (const own of ["__kIMMessagePartAttributeName", "NSString", "streamtyped", "$classname",
			"at_0_82F848B5-4D8C-4271-9226-F24FDA501B95", "82F848B54D8C42719226F24FDA501B95", "  "]) {
			expect(isBookkeeping(own)).toBe(true);
		}
		for (const said of ["ok", "NSA hearing tomorrow", "at the shop"]) {
			expect(isBookkeeping(said)).toBe(false);
		}
	});

	// Nothing readable is UNDEFINED, not a guess. The caller can then say the message could not be read
	// rather than showing somebody a line of binary.
	test("returns nothing rather than rubbish", () => {
		expect(typedstreamText(Buffer.from([0x00, 0x01, 0x02]))).toBeUndefined();
		expect(typedstreamText(Buffer.alloc(0))).toBeUndefined();
		expect(typedstreamStrings(Buffer.from("no records here", "utf8"))).toEqual([]);
	});

	// A length that runs off the end is a place we guessed wrong, not a string. It must not be emitted.
	test("refuses a record whose length overruns the blob", () => {
		expect(typedstreamStrings(Buffer.from([0x2b, 0x40, 0x41, 0x42]))).toEqual([]);
	});
});
