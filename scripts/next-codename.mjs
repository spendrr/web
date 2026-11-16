#!/usr/bin/env node
// Prints the codename for the next release: the next entry of CODENAMES after the
// codenames already used in src/lib/changelog.ts. Pass --list to see the whole row.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { CHANGELOG, CODENAMES, nextCodename } = await import(pathToFileURL(resolve("src/lib/changelog.ts")).href);
if (process.argv.includes("--list")) console.log(CODENAMES.join("\n"));
else {
  console.log(nextCodename(CHANGELOG));
}
