// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compile } from "@tailwindcss/node";
import { beforeAll, describe, expect, it } from "vitest";

const stylesheet = resolve(process.cwd(), "renderer/src/globals.css");
const controls = ["switch", "slider"].map((name) =>
  readFileSync(resolve(process.cwd(), `renderer/src/components/ui/${name}.tsx`), "utf8")
).join("\n");
const colorClasses = [
  "data-[state=checked]:bg-primary",
  "data-[state=unchecked]:bg-input",
  "dark:data-[state=unchecked]:bg-input/80",
  "bg-background",
  "dark:data-[state=unchecked]:bg-foreground",
  "dark:data-[state=checked]:bg-primary-foreground",
  "bg-muted",
  "border-primary",
  "focus-visible:ring-ring/50",
];
let css = "";

beforeAll(async () => {
  // jsdom cannot verify Tailwind's generated utilities. Compile the real shared
  // stylesheet instead so an unregistered color cannot leave a control clear.
  const compiler = await compile(readFileSync(stylesheet, "utf8"), {
    base: dirname(stylesheet),
    onDependency() {},
  });
  css = compiler.build(colorClasses);
});

describe("shared switch and slider colors", () => {
  it.each(colorClasses)("generates the %s utility used by the controls", (candidate) => {
    expect(controls.includes(candidate), "the control should use the color being tested").toBe(true);
    const selector = candidate.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    expect(css.includes(`.${selector}`), `Tailwind must generate ${candidate}`).toBe(true);
  });

  it("applies dark control colors in the default theme and excludes the light theme", () => {
    const candidate = "dark:data-[state=checked]:bg-primary-foreground";
    const escaped = candidate.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    const rule = css.split("\n").map((line) => line.trim()).find((line) => line.startsWith(`.${escaped}`));
    expect(rule).toBeDefined();
    const selector = rule!.slice(0, rule!.lastIndexOf(" {")).trim();
    const thumb = document.createElement("span");
    thumb.className = candidate;
    thumb.dataset.state = "checked";
    document.body.appendChild(thumb);
    const rootClass = document.documentElement.className;
    try {
      document.documentElement.className = "light";
      expect(thumb.matches(selector), "a light control must not receive dark-only colors").toBe(false);
      document.documentElement.className = "";
      expect(thumb.matches(selector), "the default theme should retain dark control colors").toBe(true);
    } finally {
      thumb.remove();
      document.documentElement.className = rootClass;
    }
  });
});
