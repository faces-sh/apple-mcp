import { describe, expect, test } from "bun:test";
import { unusedNumberFor } from "../utils/wrongnumber";

// THE EXACT SHAPE THAT FAILED SIX TIMES, from the real machine. Her card carries a home landline that
// has never sent or received a message in five years, and the number she actually writes from. The
// dispatcher read the landline off a conversation it had already been shown and passed it straight
// through, so nothing consulted Contacts. Every send failed with error 22 and Messages crashed seconds
// after each one.
const CARD = { name: "Linda Therrien",
  phones: ["6047304051", "7607666769", "+16046571752"], emails: ["lindycity@hotmail.com"] };
const SEEN = new Map([["+16046571752", "2026-09-01 19:04:05"]]);
const deps = {
  seenByHandle: async () => SEEN,
  whoOwns: async (h: string) => (h.replace(/\D/g, "").includes("6047304051") ? "Linda Therrien" : null),
  cardsFor: async () => [CARD],
};

describe("a number nobody has ever messaged", () => {
  test("is refused, and the one they DO write from is named", async () => {
    const r = await unusedNumberFor("(604) 730-4051", deps);
    expect(r).not.toBeNull();
    expect(r!.name).toBe("Linda Therrien");
    expect(r!.better).toBe("+16046571752");
  });

  test("the number they actually use is allowed straight through", async () => {
    expect(await unusedNumberFor("+16046571752", deps)).toBeNull();
  });

  // A GENUINELY NEW CONTACT MUST NOT BE BLOCKED. Nobody owns the number, so there is nothing to suggest
  // and no reason to refuse a first message.
  test("a number belonging to nobody is allowed", async () => {
    expect(await unusedNumberFor("+15550001111", deps)).toBeNull();
  });

  // Somebody whose ONLY number is new has no better handle to offer, so refusing would strand them.
  test("a contact with no history anywhere is allowed", async () => {
    expect(await unusedNumberFor("(604) 730-4051", {
      ...deps, seenByHandle: async () => new Map<string, string>(),
    })).toBeNull();
  });

  // Never block a send because a NICETY failed.
  test("an unreadable Contacts never blocks a send", async () => {
    expect(await unusedNumberFor("(604) 730-4051", {
      ...deps, whoOwns: async () => { throw new Error("denied"); },
    })).toBeNull();
  });
});
