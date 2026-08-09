#!/usr/bin/env node
/**
 * A mutation sweep for one source file.
 *
 * The discipline is "verify every test by breaking what it guards". Done by
 * hand that only ever covers the code you were about to change; the gaps that
 * last for months are in code nobody has touched since it was written. This
 * applies one small mutation at a time over a whole file and reports the ones
 * no test noticed.
 *
 * Tests here are colocated, and a package's suite is small, so the narrow set
 * is simply **the owning package** — no import graph to walk, and none of the
 * under-selection that costs a sibling repo's version its accuracy. The
 * confirmation is still the whole workspace, for the reason below.
 *
 * Usage: node scripts/mutate.mjs packages/<pkg>/src/<file>.ts [--limit N]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const target = process.argv[2];
if (!target) {
  console.error("usage: mutate.mjs packages/<pkg>/src/<file>.ts [--limit N]");
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`no such file: ${target}`);
  process.exit(2);
}
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg > 0 ? Number(process.argv[limitArg + 1]) : Infinity;

const pkg = target.split("/").slice(0, 2).join("/");
if (!pkg.startsWith("packages/")) {
  console.error(`expected a path under packages/, got ${target}`);
  process.exit(2);
}

const original = readFileSync(target, "utf8");

/**
 * Put the file back, whatever happens.
 *
 * This tool works by writing a *broken* copy of the source and running the
 * tests against it, so the state it must never be left in is the state it
 * spends nearly all of its time in. Restoring only at the end would mean an
 * interrupted sweep — Ctrl-C, a timeout from whatever launched it, an
 * exception in the loop — leaves the mutant on disk, and the next thing anyone
 * does is run the tests and believe the failure, or commit it.
 */
let restored = false;
function restore() {
  if (restored) return;
  restored = true;
  writeFileSync(target, original);
}
process.on("exit", restore);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restore();
    process.exit(130);
  });
}

/**
 * Mutations worth making.
 *
 * Deliberately not every operator a parser can reach: a sweep producing four
 * hundred mutants, half of them equivalent, is one nobody reads the output of.
 * These are the shapes that have actually been bugs — a boundary slid one side,
 * a comparison inverted, a conjunction widened, a negation dropped.
 */
const OPERATORS = [
  [/([^=!<>])>=/g, "$1>", "≥ → >"],
  [/([^=!<>])<=/g, "$1<", "≤ → <"],
  // `>` only on a line with no `<`. Otherwise this rewrites a TypeScript
  // generic — `Record<string, string>` becomes `Record<string, string>=` — and
  // the resulting syntax error is recorded as a *kill*, which inflates the
  // score with mutants no test could ever have been responsible for. A harness
  // whose own errors count as successes reports a suite better than it is.
  [/([^=!<>])>([^=])/g, "$1>=$2", "> → ≥", (line) => !line.includes("<")],
  [/ === /g, " !== ", "=== → !=="],
  [/ !== /g, " === ", "!== → ==="],
  [/ && /g, " || ", "&& → ||"],
  [/ \|\| /g, " && ", "|| → &&"],
  [/\(!/g, "(", "drop a negation"],
];

/** One mutant per *occurrence*, so the report can name a line. */
function mutants(source) {
  const found = [];
  const lines = source.split("\n");
  for (const [pattern, replacement, label, allow] of OPERATORS) {
    lines.forEach((line, index) => {
      // Comments and imports are noise: mutating them proves nothing.
      const trimmed = line.trim();
      if (
        trimmed.startsWith("*") ||
        trimmed.startsWith("//") ||
        trimmed.startsWith("/*") ||
        trimmed.startsWith("import ") ||
        trimmed.startsWith("export type") ||
        !trimmed
      ) {
        return;
      }
      if (allow && !allow(line)) return;
      const re = new RegExp(pattern.source, pattern.flags.replace("g", ""));
      if (!re.test(line)) return;
      const mutated = [...lines];
      mutated[index] = line.replace(re, replacement);
      if (mutated[index] === line) return;
      found.push({
        line: index + 1,
        label,
        before: trimmed.slice(0, 90),
        source: mutated.join("\n"),
      });
    });
  }
  return found;
}

function run(args, timeout) {
  try {
    execFileSync("pnpm", args, { stdio: "pipe", timeout });
    return true; // tests passed → the mutant SURVIVED
  } catch {
    return false; // tests failed → killed
  }
}

const all = mutants(original).slice(0, LIMIT);
console.log(`${target}  (suite: ${pkg})\n${all.length} mutants\n`);

const survivors = [];
let killed = 0;
for (const [n, m] of all.entries()) {
  writeFileSync(target, m.source);
  if (run(["-C", pkg, "test"], 300_000)) survivors.push(m);
  else killed += 1;
  process.stdout.write(
    `\r  ${n + 1}/${all.length}  killed ${killed}  survived ${survivors.length}   `,
  );
}
console.log("");

/**
 * Confirm each survivor against the **whole** workspace.
 *
 * A module here is consumed by other packages — `packages/core` by `server`,
 * `mcp` and `cli` — so the test that pins a rule frequently lives one package
 * away from the code. A sweep that stopped at the owning package would report
 * those as untested and buy duplicate tests for rules already covered.
 *
 * It is also why **two sweeps must not run at once**: this step reads the whole
 * tree, so a second sweep's mutant sitting in another file fails these tests
 * and every survivor here is recorded as killed. Silent, and in the direction
 * that makes the tool say everything is fine.
 */
const confirmed = [];
for (const [n, m] of survivors.entries()) {
  writeFileSync(target, m.source);
  if (run(["-r", "test"], 900_000)) confirmed.push(m);
  process.stdout.write(`\r  confirming ${n + 1}/${survivors.length}  real ${confirmed.length}   `);
}
restore();
console.log("\n");

const spurious = survivors.length - confirmed.length;
if (!confirmed.length) {
  console.log(
    `every mutant killed${spurious ? ` (${spurious} killed only by another package's tests)` : ""}`,
  );
} else {
  console.log(`SURVIVORS (${confirmed.length}) — each is an assertion nobody wrote:\n`);
  for (const s of confirmed) console.log(`  L${s.line}  ${s.label}\n     ${s.before}\n`);
  if (spurious) console.log(`  (${spurious} more were killed by another package's tests)`);
}
