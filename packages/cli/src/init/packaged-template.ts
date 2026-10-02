import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** The name the packaged template keeps its `.gitignore` under. npm leaves a `.gitignore` out of a package. */
const PACKAGED_GITIGNORE = "gitignore";

/** Copy the template files git does not ignore into the directory the CLI package ships. */
export function packageTemplate(templateDir: string, packagedDir: string): void {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: templateDir, encoding: "utf8" },
  );
  for (const file of listed.split("\0").filter(Boolean)) {
    const packagedFile = file === ".gitignore" ? PACKAGED_GITIGNORE : file;
    cpSync(join(templateDir, file), join(packagedDir, packagedFile));
  }
}

/** Copy the packaged template into a deployment repo. Throws when the repo already has one of its entries. */
export function copyPackagedTemplate(packagedDir: string, repoDir: string): void {
  const copies = readdirSync(packagedDir).map((entry) => ({
    from: join(packagedDir, entry),
    to: join(repoDir, entry === PACKAGED_GITIGNORE ? ".gitignore" : entry),
  }));
  const existing = copies.filter((copy) => existsSync(copy.to));
  if (existing.length > 0) {
    const names = existing.map((copy) => basename(copy.to));
    throw new Error(`The deployment repo already has ${names.join(", ")}.`);
  }
  for (const copy of copies) cpSync(copy.from, copy.to, { recursive: true });
}
