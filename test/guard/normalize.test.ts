import { describe, expect, it } from "vitest";
import { createRules, hasUnboundedQuantifier, isChaperoneError } from "../../src/guard";
import { normalize, originalSpan } from "../../src/guard/normalize";

const rules = createRules();
const ZW = "​";

describe("normalize", () => {
  it("drops invisible characters and maps every character back to the original", () => {
    const text = `a${ZW}b­c`;
    const n = normalize(text);
    expect(n.text).toBe("abc");
    expect(n.map).toEqual([0, 2, 4, 5]);
  });

  it("applies NFKC: fullwidth and keycap forms become plain", () => {
    expect(normalize("ｄａｎａ＠ｇｍａｉｌ．ｃｏｍ").text).toBe("dana@gmail.com");
    expect(normalize("9️⃣1️⃣").text).toBe("91");
  });

  it("folds every whitespace run to one space, and the map skips the rest of the run", () => {
    const n = normalize("a \t\n  b　 c");
    expect(n.text).toBe("a b c");
    expect(n.map).toEqual([0, 1, 6, 7, 9, 10]);
  });

  it("folds Cyrillic and Greek lookalikes to Latin, one unit each", () => {
    const n = normalize("dаnа@gmаil.cоm");
    expect(n.text).toBe("dana@gmail.com");
    expect(n.map?.length).toBe("dana@gmail.com".length + 1);
  });

  it("gives no map when a combining sequence composes (the text is still scanned)", () => {
    const n = normalize("café dana@gmail.com");
    expect(n.map).toBeNull();
    expect(n.text).toBe("café dana@gmail.com");
  });

  it("cuts a character NFKC expanded whole", () => {
    const n = normalize("ﬁx");
    expect(n.text).toBe("fix");
    expect(originalSpan(n.map!, 1, 2)).toEqual({ start: 0, end: 1 });
  });
});

describe("findings carry spans into the text the sender typed", () => {
  it("through invisible characters", () => {
    const text = `hi da${ZW}na@gmail.com`;
    const email = rules.find(text).find((f) => f.kind === "email" && f.start !== undefined);
    expect(text.slice(email!.start, email!.end)).toBe(`da${ZW}na@gmail.com`);
  });

  it("through fullwidth digits", () => {
    const text = "call ３１２５５５０１４２ ok";
    const phone = rules.find(text).find((f) => f.kind === "phone");
    expect(text.slice(phone!.start, phone!.end)).toBe("３１２５５５０１４２");
  });

  it("through folded whitespace", () => {
    const text = "write  to   dana \n\n @ gmail . com  please";
    const email = rules.find(text).find((f) => f.kind === "email" && f.start !== undefined);
    expect(text.slice(email!.start, email!.end)).toBe("dana \n\n @ gmail . com");
  });

  it("but not from the rewritten second pass", () => {
    expect(rules.find("three one two five five five zero one four two")).toEqual([{ kind: "phone" }]);
  });
});

describe("bounded patterns", () => {
  it("finds every unbounded quantifier, and only those", () => {
    for (const p of [/a*/, /a+/, /a{2,}/, /(?:ab)+?/, /\s*x/, /[a-z]+/]) expect(hasUnboundedQuantifier(p)).toBe(true);
    for (const p of [/a{0,3}/, /a{2}/, /a{2,40}/, /a?/, /[*+]/, /\*\+/, /\{2,\}/, /(?:x|y){1,5}/, /[\]+]/]) {
      expect(hasUnboundedQuantifier(p)).toBe(false);
    }
  });

  it("holds for every built-in pattern, with every option on", () => {
    const all = createRules({ streets: { named: ["Broadway"] }, platformNames: ["Acme Market"], apps: { extra: ["Acme Pay"] } });
    expect(all.detectors.length).toBeGreaterThan(30);
    for (const d of all.detectors) expect(hasUnboundedQuantifier(d.re), d.re.source).toBe(false);
  });

  it("refuses a custom detector that isn't", () => {
    let error: unknown;
    try {
      createRules({ custom: [{ kind: "handle", pattern: /member-\d+/ }] });
    } catch (e) {
      error = e;
    }
    expect(isChaperoneError(error, "unbounded_pattern")).toBe(true);
  });

  it.each([
    "a".repeat(20_000),
    "a@".repeat(10_000),
    "1 ".repeat(10_000),
    "a.".repeat(10_000),
    "1-".repeat(10_000),
    "at ".repeat(7_000),
    "x dot ".repeat(4_000),
    `${"123 ".repeat(5_000)}St`,
    `${" ".repeat(20_000)}x`,
    "9".repeat(20_000),
    "@a".repeat(10_000),
    `${"https://a.co/".repeat(1_500)}`,
  ])("a 20,000-character adversarial input finishes in under a second (%#)", (text) => {
    const t0 = performance.now();
    rules.find(text);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});
