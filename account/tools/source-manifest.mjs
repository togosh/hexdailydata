import fs from "node:fs";
import { rootCheck, git, gitBytes, digest } from "./lab.mjs";
const root = rootCheck(process.cwd());
const paths = git(root, [
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
])
  .split("\0")
  .filter(Boolean)
  .filter((p) => p !== "SOURCE_FILES.json");
const files = [...new Set(paths)].sort().map((path) => {
  const st = fs.lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink()) throw Error("NON_ORDINARY_SOURCE");
  // Hash the exact blob Git will archive, including .gitattributes normalization.
  const oid = git(root, ["hash-object", "-w", "--path=" + path, "--", path]);
  const bytes = gitBytes(root, ["cat-file", "blob", oid]);
  return { path, bytes: bytes.length, sha256: digest(bytes) };
});
fs.writeFileSync(
  "SOURCE_FILES.json",
  JSON.stringify({ kind: "lab-source", files }, null, 2) + "\n",
);
console.log("SOURCE_MANIFEST_WRITTEN");
