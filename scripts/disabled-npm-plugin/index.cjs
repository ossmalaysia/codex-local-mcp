// This project publishes GitHub releases, never npm packages. Do not install an
// unused npm CLI and its bundled dependencies in the release toolchain.
const disabled = () => { throw new Error("npm publishing is disabled. Configure GitHub-only release plugins explicitly."); };
module.exports = { verifyConditions: disabled, prepare: disabled, publish: disabled, addChannel: disabled };
