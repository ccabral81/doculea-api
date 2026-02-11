import fs from "fs";
import path from "path";

const BASE_URL = process.env.DOCULEA_BASE_URL || "http://localhost:3000";
const CASES_DIR = path.resolve("testcases/doculea/cases");
const EXPECT_PATH = path.resolve("testcases/doculea/expected/expectations.json");

function getByPath(obj, dottedPath) {
  const parts = dottedPath.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function getArrayPath(obj, pathExpr) {
  // supports "red_flags[]" meaning the array at red_flags
  if (!pathExpr.endsWith("[]")) return null;
  const base = pathExpr.slice(0, -2);
  const arr = getByPath(obj, base);
  return Array.isArray(arr) ? arr : null;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`❌ ${label}: expected "${expected}" but got "${actual}"`);
  }
}

function assertNotContains(str, forbidden, label) {
  const s = String(str ?? "");
  if (s.toLowerCase().includes(String(forbidden).toLowerCase())) {
    throw new Error(`❌ ${label}: should NOT contain "${forbidden}"`);
  }
}

async function runCase(caseFile, expectations) {
  const full = path.join(CASES_DIR, caseFile);
  const c = JSON.parse(fs.readFileSync(full, "utf8"));
 
  if (!c.documentText && c.documentTextFile) {
  const textPath = path.join(CASES_DIR, c.documentTextFile);
  c.documentText = fs.readFileSync(textPath, "utf8");
}

 const id = c.id;

  const exp = expectations[id];
  if (!exp) throw new Error(`No expectations entry for case id="${id}"`);

  const payload = {
    documentText: c.documentText,
    lang: c.language || c.lang || exp.lang || "en",
  };

  const r = await fetch(`${BASE_URL}/api/doculea/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`❌ ${id}: HTTP ${r.status} ${r.statusText}\n${txt}`);
  }

  const out = await r.json();

  // Required invariants
  if (!Array.isArray(out.step_by_step_actions) || out.step_by_step_actions.length < 2) {
    throw new Error(`❌ ${id}: step_by_step_actions missing or too short`);
  }

  // Exact expectations
  const expects = exp.expect || {};
  for (const [k, v] of Object.entries(expects)) {
    const actual = getByPath(out, k);
    assertEqual(actual, v, `${id} ${k}`);
  }

  // Forbidden phrases
  for (const rule of exp.forbid_contains || []) {
    const { path: pth, value } = rule;

    const arr = getArrayPath(out, pth);
    if (arr) {
      for (const item of arr) assertNotContains(item, value, `${id} ${pth}`);
    } else {
      const val = getByPath(out, pth);
      assertNotContains(val, value, `${id} ${pth}`);
    }
  }

  console.log(`✅ ${id} passed`);
}

async function main() {
  const expectations = JSON.parse(fs.readFileSync(EXPECT_PATH, "utf8"));
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith(".json"));

  if (files.length === 0) {
    console.log("No cases found in", CASES_DIR);
    process.exit(0);
  }

  let failed = 0;
  for (const f of files) {
    try {
      await runCase(f, expectations);
    } catch (e) {
      failed++;
      console.error(String(e?.message || e));
    }
  }

  if (failed > 0) {
    console.error(`\n❌ Regression pack failed: ${failed} case(s)`);
    process.exit(1);
  }

  console.log(`\n✅ All regression cases passed (${files.length})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
