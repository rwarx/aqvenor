const fs = require("fs");
const base = "electron/renderer/src/lib/aqvenor/i18n/";
const all = {};
for (const loc of ["en", "ru", "de"]) {
  const src = fs.readFileSync(base + loc + ".ts", "utf8");
  const keys = [];
  const re = /^[ \t]*"([^"]+)":/gm;
  let m;
  while ((m = re.exec(src)) !== null) { keys.push(m[1]); }
  const seen = new Set();
  const dups = [];
  for (const k of keys) { if (seen.has(k)) { dups.push(k); } seen.add(k); }
  all[loc] = seen;
  console.log(loc + ": total=" + keys.length + " unique=" + seen.size + " dups=" + (dups.length ? dups.join(",") : "none"));
}
const en = all.en;
for (const loc of ["ru", "de"]) {
  const missing = [...en].filter((k) => !all[loc].has(k));
  const extra = [...all[loc]].filter((k) => !en.has(k));
  const show = (arr) => (arr.length > 12 ? arr.length + " (see below)" : arr.join(" | "));
  console.log("--- " + loc + " missing(" + missing.length + "): " + show(missing));
  console.log("--- " + loc + " extra(" + extra.length + "): " + show(extra));
}
