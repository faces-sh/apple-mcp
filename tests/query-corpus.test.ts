import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseQuery } from "../utils/query";

// THE SHARED CORPUS (faced#625). The same file is parsed by the Python side, so a grammar that drifts
// between the two languages fails a test here rather than surprising somebody whose search came back
// empty in one integration and full in another.
const corpus = JSON.parse(
  readFileSync(join(import.meta.dirname, "../shared/query-corpus.json"), "utf8"));

describe("the shared query grammar", () => {
  for (const c of corpus.cases as { why: string; query: string; terms: string[];
                                    phrases: string[]; excluded: string[] }[]) {
    test(c.why, () => {
      const got = parseQuery(c.query);
      expect(got.terms).toEqual(c.terms);
      expect(got.phrases).toEqual(c.phrases);
      expect(got.excluded).toEqual(c.excluded);
    });
  }
});
