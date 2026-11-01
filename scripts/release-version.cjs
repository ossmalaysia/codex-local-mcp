const fs = require("node:fs");
// semantic-release remains the source of version numbers. The Windows job consumes its result.
exports.prepare = async (_options, context) => {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version=${context.nextRelease.version}\ntag=${context.nextRelease.gitTag}\n`);
  }
};
