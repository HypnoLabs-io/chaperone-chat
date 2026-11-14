/**
 * Spanish: number words, "arroba" / "punto" spelled out, and the asks ("tu número", "llámame", "tu apellido",
 * "fuera de la app").
 */
import type { Locale, LocaleContext } from "./types";

const DIGIT_WORDS: Readonly<Record<string, string>> = {
  cero: "0", uno: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9",
};

function asks({ platformNames }: LocaleContext): RegExp[] {
  const platforms = `app|aplicaci[oó]n|plataforma|p[aá]gina|chat${platformNames ? `|${platformNames}` : ""}`;
  return [
    /\b(?:mi|tu|su)\s{1,3}(?:n[uú]mero|tel[eé]fono|cel(?:ular)?|correo|e-?mail|whats(?:app)?|direcci[oó]n|instagram|insta|facebook)\b|\b(?:tu|su)\s{1,3}apellido\b|\b(?:ll[aá]ma(?:me|nos)|escr[ií]be(?:me|nos)|text[eé]a?me|m[aá]nda(?:me|nos)\s{1,3}un\s{1,3}(?:mensaje|texto|correo|whats(?:app)?))\b/gi,
    new RegExp(String.raw`\bfuera\s{1,3}de\s{1,3}(?:la\s{1,3}|esta\s{1,3}|este\s{1,3})?(?:${platforms})(?![\w])`, "gi"),
  ];
}

export const es: Locale = {
  id: "es",
  digitWords: DIGIT_WORDS,
  atWords: ["arroba"],
  dotWords: ["punto"],
  asks,
};
