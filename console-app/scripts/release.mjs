// Release helper for ComfyQ Console (the desktop app).
//
// `npm version <type> --no-git-tag-version` (in the release:* scripts) bumps
// package.json + package-lock.json without touching git; this script then
// commits the bump, tags it `console-v<version>` and pushes both, which starts
// .github/workflows/console-app.yml: it builds the Windows installer and
// publishes it as a GitHub Release, from which installed apps update.
//
// ★ The tag is `console-v…`, never `v…`: `v*` tags start the Discovery
// release (release.yml), and `docker-v*` the image build.
//
// Run from console-app/, on main:   npm run release:patch   (or :minor / :major)

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
const capture = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const tag = `console-v${version}`;

const branch = capture('git rev-parse --abbrev-ref HEAD');
if (branch !== 'main') {
    console.warn(`\n⚠  You are on "${branch}", not "main". Releases are cut from main. Aborting.\n`);
    process.exit(1);
}

console.log(`\nReleasing ${tag} from ${branch}…`);
// Only the version files, so an unrelated dirty file stays out of the release commit.
run('git add package.json package-lock.json');
run(`git commit -m "console-app: release ${tag}"`);
run(`git tag -a ${tag} -m "ComfyQ Console ${version}"`);
run('git push origin HEAD --follow-tags');
console.log(`\n✓ Pushed ${tag}. CI is now building and publishing the installer.`);
