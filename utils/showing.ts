/**
 * A PAGE OF RESULTS SAYS WHAT IT IS A PAGE OF.
 *
 * The same bug turned up four times in one week, in four unrelated places, and it was never a size
 * problem:
 *
 *     notes list       1,000 of 3,152, silently
 *     contacts list       252 of 1,645, silently
 *     mail search          10 of about 201, silently
 *     messages unread      10 of 70, silently
 *
 * Each one answered a question truthfully about the rows it was holding and said nothing about the rows
 * it had stopped at, so a caller could not tell "that is all of them" from "that is where I stopped".
 * A quietly partial answer is worse than a big one, because the caller acts on it: the agent, asked how
 * many invoice emails there were, said ten.
 *
 * One sentence, shared, so the fifth place gets it right for free.
 */
export function showing(shown: number, total: number, noun: string,
                        ofWhat = "", ceiling = 0): string {
    const about = ofWhat ? ` ${ofWhat}` : "";
    if (shown === 0) return `No ${noun}${about}.`;
    // Never claim fewer than we are holding. A total that comes back under the page is a broken count,
    // and "showing 10 of 4" reads as a bug in us rather than a fact about their data.
    const real = Math.max(total, shown);
    if (real <= shown) return `${shown} ${noun}${about}:`;
    // AT THE CEILING, "ask for more" is a promise this tool cannot keep. `messages` clamps at 50, so on
    // a Mac with 70 unread a caller who took that advice would ask for 100 and get 50 again, and learn
    // nothing except that we were wrong. Naming a way out that does not exist is worse than naming none:
    // it is the same fault as the silent cap, one level up.
    const stuck = ceiling > 0 && shown >= ceiling;
    const advice = stuck
        ? `${shown} is the most this can return at once, so narrow the search to see the rest`
        : "Ask for more with limit, or narrow the search";
    return `Showing ${shown} of ${real} ${noun}${about}. ${advice}:`;
}
