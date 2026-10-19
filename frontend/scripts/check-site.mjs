// Fails the website build if anything in it could reach the lab's private builds.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../../site-dist/", import.meta.url).pathname;
const FORBIDDEN = [
  /groups\/PekoszLab\//, // private Nextstrain group dataset path (PekoszLab-Public is fine)
  /nextstrain\.org\/groups\/PekoszLab(?!-Public)/,
  /\/api\/(compare|options|export)/, // the local app's private-data API must not be called by the site
];
const files = [];
const walk = (d) => readdirSync(d).forEach((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : files.push(join(d, f))));
walk(root);
let bad = 0;
for (const f of files.filter((f) => /\.(html|js|css|json)$/.test(f))) {
  const text = readFileSync(f, "utf8");
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) {
      console.error(`PRIVACY CHECK FAILED: ${f.replace(root, "site-dist/")} contains ${JSON.stringify(m[0])}`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log(`privacy check passed: ${files.length} files, no private-build paths or local-API calls`);
