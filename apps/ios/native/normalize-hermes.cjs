const assert = require('node:assert/strict');
const {readFileSync, writeFileSync} = require('node:fs');
const path = require('node:path');

const podspec = path.join(__dirname, 'node_modules/react-native/sdks/hermes-engine/hermes-engine.podspec');
const original = "'HERMES_CLI_PATH' => \"#{hermes_compiler_path}/hermesc/osx-bin/hermesc\"";
const portable = "'HERMES_CLI_PATH' => '${PODS_ROOT}/../../node_modules/hermes-compiler/hermesc/osx-bin/hermesc'";
const source = readFileSync(podspec, 'utf8');
assert(source.includes(original) || source.includes(portable), 'Review the Hermes path normalization after a React Native upgrade.');
writeFileSync(podspec, source.replace(original, portable));
