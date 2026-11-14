import { describe, expect, it } from "vitest";
import { createGuard, createRules, kindsOf, WINDOW_KINDS, WINDOW_REASONS } from "../../src/guard";
import { BLOCKED } from "../fixtures/corpus";

const rules = createRules();
const kinds = (text: string) => kindsOf(rules.find(text));

describe("the rules", () => {
  it("give spans that fit the text they were given", () => {
    for (const [text] of BLOCKED) {
      for (const f of rules.find(text)) {
        if (f.start === undefined) continue;
        expect(f.start).toBeGreaterThanOrEqual(0);
        expect(f.end).toBeGreaterThan(f.start);
        expect(f.end).toBeLessThanOrEqual(text.length);
      }
    }
  });

  it("refuse asking to be looked up, not the idiom", () => {
    for (const text of ["google me", "Google my name.", "search my name", "look up my full name", "find my name"]) {
      expect(kinds(text)).toContain("ask");
    }
    for (const text of ["Search for me on Facebook.", "search me up on insta", "Can you search for me?"]) {
      expect(kinds(text)).toContain("ask");
    }
    expect(rules.find("Search me, I have no idea.")).toEqual([]);
  });

  it("refuse asking for a name, never offering one", () => {
    for (const text of ["your last name?", "What's your full name?", "ur surname", "¿Y tu apellido?"]) {
      expect(kinds(text)).toContain("ask");
    }
    for (const text of ["My last name is Lee.", "My full name is Dana Kim.", "Mi apellido es Gómez."]) {
      expect(rules.find(text)).toEqual([]);
    }
  });

  it(`read "oh" as zero only between digits`, () => {
    expect(kinds("eight six seven five three oh nine")).toContain("phone");
    expect(rules.find("Oh one more thing, the dresser has a scratch.")).toEqual([]);
  });

  it("refuse a video call outright, but not videos or online sessions", () => {
    for (const text of [
      "We can video chat if that's easier.",
      "Can we do a quick video call first?",
      "Video-call works for me.",
      "vid chat?",
      "I do a lot of video calling with clients.",
    ]) {
      expect(kinds(text)).toContain("ask");
    }
    for (const text of ["I watch a lot of YouTube cooking videos.", "Online sessions work for us.", "The video was great."]) {
      expect(rules.find(text)).toEqual([]);
    }
  });

  it("refuse a phone call someone asks to get on, but not the English word", () => {
    for (const text of [
      "Can we hop on a quick call?",
      "Could we jump on a call this week?",
      "A short phone call first would help.",
      "Give me a call tonight.",
      "Happy to do an intro call.",
    ]) {
      expect(kinds(text)).toContain("ask");
    }
    for (const text of ["Good call on the schedule.", "It was a close call on the deadline.", "Roll call is at 8."]) {
      expect(rules.find(text)).toEqual([]);
    }
  });

  it(`name WeChat, not "we chat"; Zoom the app, not the verb`, () => {
    expect(kinds("I'm on WeChat")).toContain("app");
    expect(rules.find("Can we chat on Tuesday?")).toEqual([]);
    expect(kinds("Zoom works for us.")).toContain("app");
    expect(rules.find("Can you zoom in on the photo?")).toEqual([]);
  });

  it(`read "call me" as an ask, not before a name`, () => {
    expect(kinds("Call me tonight.")).toContain("ask");
    expect(rules.find("You can call me Ms. G.")).toEqual([]);
  });

  it("don't count someone counting as a phone number, but do count a real one", () => {
    expect(rules.find("1234567")).toEqual([]);
    expect(rules.find("9876543")).toEqual([]);
    expect(kinds("1234568")).toContain("phone");
  });

  it("don't read a number beside a street as an address when a common word sits between", () => {
    expect(rules.find("We're 5 minutes from Lincoln Ave.")).toEqual([]);
    expect(rules.find("3 bedrooms on Maple Ave.")).toEqual([]);
    expect(kinds("We're at 85 Riverside Pkwy.")).toEqual(["address"]);
  });

  it("don't read a street across the end of a sentence", () => {
    // Clean sentences side by side: "9 10. It's 650 square" and "30 inches. It's 650 square" aren't streets.
    expect(rules.find("My son can count to 10: 1 2 3 4 5 6 7 8 9 10. It's 650 square feet.")).toEqual([]);
    expect(rules.find("Table 4 seats 10. Union Square is a short walk.")).toEqual([]);
    expect(rules.find("Measurements are 84 x 36 x 30 inches. It's 650 square feet.")).toEqual([]);
    // Nor once number words are read as digits ("one on one" → "1 on 1").
    expect(rules.find("I'd like one on one coaching. It's 650 square feet.")).toEqual([]);
    // The abbreviations a street's name holds keep their full stop.
    expect(kinds("We're at 450 W. 33rd St.")).toEqual(["address"]);
    expect(kinds("It's 12 Mt. Vernon Pl, second floor.")).toEqual(["address"]);
    expect(kinds("Meet me at 77 Mass. Ave.")).toEqual(["address"]);
  });

  it("read a state and its ZIP code, the two-letter code only in capitals", () => {
    expect(kinds("Springfield, IL 62704")).toEqual(["address"]);
    expect(kinds("Albany, new york 12207")).toEqual(["address"]);
    expect(rules.find("That's 3 hours in 10000 steps.")).toEqual([]);
  });

  it("read Spanish spellings of at and dot", () => {
    // "gmail punto com" is a spelled-out domain too, as "gmail dot com" is in English.
    expect(kinds("dana arroba gmail punto com")).toEqual(["email", "link"]);
    expect(kinds("dana at gmail dot com")).toEqual(["email", "link"]);
    expect(kinds("danadesigns punto com")).toEqual(["link"]);
  });
});

describe("the split-message pass", () => {
  const guard = createGuard();

  it("reads only the last few of the sender's earlier messages", () => {
    // Six earlier pieces: the first falls out, and nine digits are no number.
    expect(guard.windowKinds(["three", "one", "two", "five", "five", "five"], "zero one four two")).toEqual([]);
    expect(guard.windowKinds(["three one", "two", "five", "five", "five"], "zero one four two")).toEqual(["phone"]);
    expect(guard.windowKinds(["three", "one two", "five", "five", "five"], "zero one four two", 6)).toEqual(["phone"]);
  });

  it("counts only what the new message adds", () => {
    expect(guard.windowKinds(["312", "555", "0142"], "Thanks!")).toEqual([]);
    expect(guard.windowKinds([], "312 555 0142")).toEqual([]);
  });

  it("needs a phone's area code", () => {
    expect(guard.windowKinds(["867"], "5309")).toEqual([]);
    expect(guard.windowKinds(["312", "867"], "5309")).toEqual(["phone"]);
  });

  it("refuses an email or a phone only, with a sentence for each", () => {
    expect(guard.windowKinds(["you can find me"], "on LinkedIn")).toEqual([]);
    expect(guard.windowKinds(["The building is", "220"], "Elm Street")).toEqual([]);
    for (const kind of WINDOW_KINDS) expect(WINDOW_REASONS[kind]).toMatch(/\.$/);
  });

  it("is off with no earlier messages allowed", () => {
    expect(guard.windowKinds(["312", "555"], "0142", 0)).toEqual([]);
  });
});
