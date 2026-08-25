import { describe, expect, test } from "bun:test";
import { contactLine, contactsIndex } from "../utils/contacts-render";

// These guard ONE thing, and it is the thing that was broken: whether a person with an email address
// and no phone number is in the list at all.
//
// Listing "all contacts" went through a phone-only path, so on a real address book it answered
// `Found 252 contacts` when there were 1,645. Nothing was capped, so nothing said so.
//
// Verified by restoring the bug: `contactsIndex` filtered to `c.phones.length > 0` (which is what
// getAllNumbers did) fails 3 of these, answering "Found 2 contacts" where there are 4. The current one
// passes all 6.

const BOOK = [
	{ id: "1", name: "Laura Stein", emails: ["stein@example.com"], phones: [] },
	{ id: "2", name: "Didier Faustino", emails: [], phones: ["+33 6 80 47 10 00"] },
	{ id: "3", name: "Both Ways", emails: ["both@example.com"], phones: ["+15551234567"] },
	{ id: "4", name: "Name Only", emails: [], phones: [] },
];

describe("contactsIndex", () => {
	const text = contactsIndex(BOOK);

	test("includes somebody who has an email and no phone", () => {
		// THE BUG. 1,507 of 1,645 cards on a real Mac look like this.
		expect(text).toContain("Laura Stein");
		expect(text).toContain("stein@example.com");
	});

	test("still includes somebody who has a phone and no email", () => {
		expect(text).toContain("Didier Faustino");
		expect(text).toContain("+33 6 80 47 10 00");
	});

	test("includes a card with neither, and says it has neither", () => {
		expect(text).toContain("Name Only");
		expect(text).toContain("(no email or phone on the card)");
	});

	test("counts what it actually shows", () => {
		expect(text).toContain("Found 4 contacts");
		expect(text.split("\n").filter((l) => l.includes(": ")).length).toBe(4);
	});

	test("an empty book is empty, not a permission problem", () => {
		const empty = contactsIndex([]);
		expect(empty).toContain("No contacts found");
		expect(empty).not.toContain("access");
		expect(empty).not.toContain("permission");
	});
});

describe("contactLine", () => {
	test("emails come before phones, because that is what people ask for", () => {
		const line = contactLine(BOOK[2]);
		expect(line.indexOf("both@example.com")).toBeLessThan(line.indexOf("+15551234567"));
	});
});
