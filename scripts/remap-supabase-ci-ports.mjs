import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const servicePortMappings = [
  ["port = 55321", "port = 56321"],
  ["port = 55322", "port = 56322"],
  ["port = 55329", "port = 56329"],
  ["port = 55323", "port = 56323"],
  ["port = 55324", "port = 56324"],
  ["port = 55327", "port = 56327"],
];
const shadowPortMapping = ["shadow_port = 55320", "shadow_port = 56320"];

function replaceExactlyOnce(source, [before, after]) {
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected exactly one Supabase config entry ${before}; found ${occurrences}`,
    );
  }
  return source.replace(before, after);
}

export function remapSupabaseCiPorts(source) {
  let remapped = source;
  for (const mapping of servicePortMappings) {
    remapped = replaceExactlyOnce(remapped, mapping);
  }
  remapped = replaceExactlyOnce(remapped, shadowPortMapping);
  if (/\b(?:shadow_)?port = 553\d{2}\b/u.test(remapped)) {
    throw new Error("Supabase CI config still contains a reserved 553xx port");
  }
  return remapped;
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const configPath = resolve("supabase/config.toml");
  const original = readFileSync(configPath, "utf8");
  const remapped = remapSupabaseCiPorts(original);
  writeFileSync(configPath, remapped, "utf8");
  console.log(
    "Remapped six Supabase service ports and the shadow port from 553xx to isolated 563xx",
  );
}
