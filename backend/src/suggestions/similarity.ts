// Cheap wording similarity for spotting likely-duplicate titles without a
// model call -- a hint for the reviewer, never an automatic merge. Catches
// the common case of the same question phrased twice ("Which path should
// be chosen for Aim 1..." vs "What path should be chosen for Aim 1...").

const STOPWORDS = new Set(
  "a an and are as at be been being by can could did do does for from had has have how if in into is it its of on or should so than that the their them then there these this those to up was we were what when where which who whom why will with would".split(
    " ",
  ),
);

// Light stemming so "restart"/"restarted"/"restarting" and "test"/"tests"
// count as the same word; deliberately crude -- this only needs to be good
// enough to raise a hint.
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

export function titleTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9#]+/g, " ")
      .split(" ")
      .filter((w) => w && !STOPWORDS.has(w))
      .map(stem),
  );
}

// Average of Dice (overall overlap) and the overlap coefficient (how much of
// the shorter title the longer one covers), so a short rephrasing of a long
// title still scores high.
export function titleSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  const dice = (2 * shared) / (a.size + b.size);
  const overlap = shared / Math.min(a.size, b.size);
  return (dice + overlap) / 2;
}

export const LIKELY_DUPLICATE_THRESHOLD = 0.7;
