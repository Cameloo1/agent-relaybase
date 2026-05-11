const fs = require("node:fs");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1] ?? "");
}

const mode = args.get("--mode") || "success";
const marker = args.get("--marker");
const label = args.get("--label") || mode;

console.log(`[fake-compose:${label}] stdout port=${process.env.PORT || ""}`);
if (process.env.SECRET_TOKEN) {
  console.error(`[fake-compose:${label}] secret=${process.env.SECRET_TOKEN}`);
}

if (marker) {
  fs.appendFileSync(marker, `${label}:${mode}:${process.env.PORT || ""}\n`);
}

if (mode === "hang") {
  setInterval(() => undefined, 1000);
} else if (mode === "fail") {
  process.exit(7);
} else {
  process.exit(0);
}
