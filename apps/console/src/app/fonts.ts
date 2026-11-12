import localFont from "next/font/local";

/**
 * The console's fonts, served by the console itself (no other origin: the CSP allows none).
 *
 * Rule: a font that arrives late must not move anything. A row that moves under the finger while a web font swaps in
 * is the same bug as a row that moves after Acknowledge. So every face is `font-display: optional`: it is used when it
 * is there for the first paint (it is preloaded, and cached for a year after the first visit) and otherwise this page
 * view stays on the fallback — it never swaps. The fallbacks are metric-adjusted (size-adjust, ascent/descent
 * override, in the design system's tokens.css), so the two renderings wrap and space lines almost alike.
 * e2e/y-fonts.spec.ts holds the fonts back and measures 0 px at 390 and 1440.
 *
 * Files (SIL OFL 1.1, licences beside them in ./fonts):
 * - Pretendard Std 1.3.9 (npm pretendard-std): the Latin subset (56 KB, preloaded) carries the interface text;
 *   the whole of Pretendard Std (292 KB) is fetched only for a sign the subset lacks (✓ → ▲ ⌘).
 * - Pretendard 1.3.9 variable (2 MB): only for Hangul / CJK in customer data, never preloaded.
 * - Space Mono 400 / 700, Latin subset (npm @fontsource/space-mono 5.3.0), preloaded.
 *
 * next/font wants every value written out as a literal, so the unicode ranges are repeated in place.
 */

export const sansLatin = localFont({
  src: "./fonts/PretendardStdVariable.latin.woff2",
  weight: "45 920",
  display: "optional",
  preload: true,
  variable: "--font-sans-latin",
  // the adjusted fallback ("Pretendard Fallback") is in the design system's tokens.css, after all three Pretendard faces:
  // next/font would put it right behind this one, where it would shadow the signs and the Hangul
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
});

export const sansSigns = localFont({
  src: "./fonts/PretendardStdVariable.woff2",
  weight: "45 920",
  display: "optional",
  preload: false,
  variable: "--font-sans-signs",
  adjustFontFallback: false,
});

export const sansKorean = localFont({
  src: "./fonts/PretendardVariable.woff2",
  weight: "45 920",
  display: "optional",
  preload: false,
  variable: "--font-sans-korean",
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+1100-11FF, U+3000-30FF, U+3130-318F, U+3200-32FF, U+4E00-9FFF, U+A960-A97F, U+AC00-D7FF, U+F900-FAFF, U+FF00-FFEF" }],
});

export const mono = localFont({
  src: [
    { path: "./fonts/SpaceMono-Regular.latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/SpaceMono-Bold.latin.woff2", weight: "700", style: "normal" },
  ],
  display: "optional",
  preload: true,
  variable: "--font-mono",
  // next/font only adjusts against Arial or Times; the monospace fallbacks are adjusted in the design system's tokens.css
  adjustFontFallback: false,
  declarations: [{ prop: "unicode-range", value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD" }],
});

/** on <html>: defines --font-sans-latin, --font-sans-signs, --font-sans-korean and --font-mono, which the design tokens read */
export const fontVariables = [sansLatin.variable, sansSigns.variable, sansKorean.variable, mono.variable].join(" ");
