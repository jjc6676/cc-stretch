// Checks lead-in words in a live session: the words written before a stretch whose short form has no
// words (a lone `.` or an empty short form) are drawn underlined and a click on them opens it, while a
// drag or a double-click there selects text, the words run back to the start of their sentence, two
// links in one sentence stay apart, they stay pressable while another stretch grows, and the note to
// Claude names such a stretch by them. Claude is told to reply with a fixed sample, so every package
// is checked against the same paragraphs. Each step records what it saw, and every mouse report sent
// is kept with its cell. The reader's clipboard text is kept and put back. Run it from a folder Claude
// Code already trusts: the check does not answer the trust question. It exits 1 when a step fails or a
// verdict cannot be trusted (`report.valid`).
//   node film/e2e/lead-in.mjs <package> <outDir>
import { execFileSync } from 'node:child_process';
import { parseScreen, plainRows, turnsDone } from '../screen.mjs';
import { sleep, startCheck } from './live.mjs';

const [PLUGIN, OUT] = process.argv.slice(2);
// One paragraph per behaviour under test.
const SAMPLE = [
	'The PR merged 3 days ago{{.|, and the e2e run passed.}} The second one is approved{{.|, but a failing e2e test blocks it.}}',
	'Edit hooks/reply.tsx first{{.|, then rerun the tests.}}',
	'Retries wait 200, 400 and 800 ms{{.|, doubling each time.}}',
	'Run {{the tests|the unit tests}} then merge{{.|, after review.}}',
	'The type check exited 0{{|, so it found no errors}}. {{The fix is one line.|The fix is one line in `ci/cache.ts`, where the cache key now hashes the lockfile as well as `package.json`.}}',
].join('\n\n');
// Each paragraph as it reads with every stretch closed.
const SHORT = ['The PR merged 3 days ago. The second one is approved.', 'Edit hooks/reply.tsx first.', 'Retries wait 200, 400 and 800 ms.', 'Run the tests then merge.', 'The type check exited 0. The fix is one line.'];
const APPEND = `This session is a recorded product test. Write in English only, use no tools, and do not end replies with a status block or any closing summary. When the user writes \`sample\`, reply with exactly the text between the lines BEGIN and END, character for character, with nothing before or after it and no tools. When the user writes \`note\`, copy the Stretchtext note attached to their message exactly, inside a code block, and nothing else; if there is none, write \`no note\`.
BEGIN
${SAMPLE}
END`;
const SENTINEL = 'cc-stretch-lead-sentinel';
// A press and its release, and the presses of a double-click, as far apart as a hand makes them.
const CLICK_MS = 90, DOUBLE_GAP_MS = 90;
// A wait that outlasts the 500 ms a click on lead-in words may wait for a second press, with room to draw.
const SETTLE_MIN_MS = 1800;

const paste = () => execFileSync('pbpaste', { encoding: 'utf8' });
const copy = (text) => execFileSync('pbcopy', { input: text });
const keptClipboard = paste();

const live = startCheck({ plugin: PLUGIN, out: OUT, append: APPEND });
const { frames, now, report, rows, screen, step, submit, text, waitFor } = live;
// Every mouse report sent, with the moment `wezterm cli send-text` returned and the cell it names.
const pointer = [];
const observations = {};
report.observations = observations;
report.pointer = pointer;

function mouse(button, row, col, isUp = false) {
	live.mouse(button, row, col, isUp);
	pointer.push({ t: now(), button, row, col, up: isUp });
}
async function click(row, col) {
	mouse(0, row, col);
	await sleep(CLICK_MS);
	mouse(0, row, col, true);
}
async function doubleClick(row, col) {
	await click(row, col);
	await sleep(DOUBLE_GAP_MS);
	await click(row, col);
}
/** Presses on `from`, moves with the button held across the row to `to`, and releases there. */
async function drag(row, from, to) {
	mouse(0, row, from);
	await sleep(120);
	for (let col = from + 3; col < to; col += 3) {
		mouse(32, row, col);
		await sleep(40);
	}
	mouse(32, row, to);
	await sleep(80);
	mouse(0, row, to, true);
}
/**
 * Moves the pointer, no button held, a cell along from where the last gesture ended and then onto the
 * row that ends the turn, off every paragraph, as a hand moving away does: a selection the plugin drew
 * goes once its paragraph hears the pointer leave, which it hears only after a move inside it.
 */
async function pointerAway() {
	const last = pointer.at(-1);
	const r = rows().findIndex((x) => / · done /.test(x));
	if (last === undefined || r < 0) return;
	mouse(35, last.row, last.col + 1);
	await sleep(150);
	mouse(35, r, 1);
	await sleep(400);
	const [from, end] = sampleRange();
	const isCleared = !screen().slice(from, end).some((runs) => runs.some((x) => x.inverse && x.text.trim() !== ''));
	(report.pointerAway ??= []).push({ t: now(), isCleared });
}
/**
 * Waits at least `min` ms, then until the screen has not changed for `quiet` ms, up to `max` ms. With
 * no screen recorded it waits the whole `max`, as nothing shows the screen still.
 */
async function settle(min = SETTLE_MIN_MS, quiet = 800, max = 10000) {
	const start = Date.now();
	await sleep(min);
	while (Date.now() - start < max) {
		const last = frames.at(-1)?.t;
		if (last !== undefined && (now() - last) * 1000 >= quiet) return;
		await sleep(100);
	}
}

/** The rows of Claude's answer to `prompt`: from the row after it to the line that ends its turn; none while it is not drawn. */
function answerRange(prompt) {
	const [from, end] = live.replyRange(new RegExp(`^[❯>] ${prompt}\\s*$`));
	return from < 0 ? [0, 0] : [from + 1, end];
}
const sampleRange = () => answerRange('sample');
/** Where `phrase` first stands in the sample reply's rows, as { row, col }, or undefined. */
function locate(phrase, within = sampleRange()) {
	const r = rows();
	for (let i = within[0]; i < within[1]; i++) {
		const col = r[i].indexOf(phrase);
		if (col >= 0) return { row: i, col, len: phrase.length };
	}
	return undefined;
}
/** The styled run covering cell `col` of `row` on `parsed`, the screen now unless given. */
function runAt(row, col, parsed = screen()) {
	return (parsed[row] ?? []).find((x) => col >= x.col && col < x.col + x.text.length);
}
const isUnderlined = (row, col, parsed) => runAt(row, col, parsed)?.underline === true;
/** The letters of `at` (spaces left out) that are not underlined, as a string with gaps. */
function notUnderlined(at, parsed = screen()) {
	const line = plainRows(parsed)[at.row] ?? '';
	let missing = '';
	for (let i = 0; i < at.len; i++) {
		const ch = line[at.col + i] ?? ' ';
		missing += ch !== ' ' && !isUnderlined(at.row, at.col + i, parsed) ? ch : ' ';
	}
	return missing.trim();
}
/** The underlined text on `row`, runs joined with a `|` where a gap falls between them. */
function underlinedOn(row, parsed = screen()) {
	const parts = [];
	let last = -2;
	for (const run of parsed[row] ?? []) {
		if (!run.underline) continue;
		parts.push(run.col === last ? run.text : `${parts.length > 0 ? '|' : ''}${run.text}`);
		last = run.col + run.text.length;
	}
	return parts.join('');
}
const collapsed = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * Starts a gesture on `phrase` that should copy text and open nothing: the clipboard holds a sentinel
 * first, so what the gesture copied, if anything, can be told apart from what was there.
 */
async function copyGesture(phrase, gesture) {
	const at = locate(phrase);
	if (at === undefined) return false;
	copy(SENTINEL);
	await gesture(at);
	await settle();
}
/** What a copying gesture did, recorded as step `name`'s observation: what it copied and whether `openedRe` shows. */
function copyOutcome(name, openedRe, extra = {}) {
	const pasted = paste();
	const copied = pasted === SENTINEL ? null : pasted;
	const isOpened = openedRe.test(text());
	observations[name] = { copied, isOpened, ...extra, detail: `${copied === null ? 'nothing copied' : `copied “${copied}”`}${isOpened ? ' · the stretch opened' : ' · stayed closed'}` };
	return { copied, isOpened };
}

let error;
// openPane's recording loop in film/recorder.mjs rejects once its pane is gone, as when the session
// exits, and nothing awaits it until close(): kept here, the run goes on to finish().
process.on('unhandledRejection', (reason) => {
	report.paneError = String(reason?.message ?? reason);
	console.log('pane error:', report.paneError.split('\n')[0]);
});
// Interrupted, closed or killed, the run puts the clipboard back before anything else can fail.
for (const [signal, code] of [['SIGINT', 130], ['SIGHUP', 129], ['SIGTERM', 143]]) {
	process.on(signal, () => {
		copy(keptClipboard);
		live.finish(new Error(`stopped by ${signal}`)).finally(() => process.exit(code));
	});
}
try {
	live.open();
	await step('reply', 'Claude writes the sample reply: the words before each lone period are drawn underlined, like a link', async () => {
		// A folder never trusted asks first. Trusting one is the person's choice, so the check stops there.
		await waitFor(() => /─\n❯/.test(text()) || /Enter to confirm/.test(text()), 90000);
		if (/Enter to confirm/.test(text())) {
			observations.trust = 'Claude Code asked whether to trust the folder: start claude there once and answer it';
			console.log(observations.trust);
			return false;
		}
		if (!(await live.ready())) return false;
		const rule = rows().find((x) => /^─{20,}/.test(x)) ?? '';
		// A read of the screen can end in one more row with nothing on it, the reset after the last row.
		const drawnRows = rows().length - (rows().at(-1)?.trim() === '' && rows().length === report.size.rows + 1 ? 1 : 0);
		observations.pane = { rows: drawnRows, cols: rule.length };
		if (drawnRows !== report.size.rows || rule.length !== report.size.cols) return false;
		await submit('sample');
	}, () => {
		if (turnsDone(text()) < 1) return false;
		const reply = collapsed(rows().slice(...sampleRange()).join(' '));
		const isExact = SHORT.every((p) => reply.includes(p));
		const underlined = ['merged 3 days ago', 'approved', 'hooks/reply.tsx', '800 ms', 'the tests', 'then merge', 'exited 0', 'The fix is one line'].map((p) => {
			const at = locate(p);
			return { phrase: p, at, missing: at === undefined ? p : notUnderlined(at) };
		});
		observations.reply = { reply, isExact, underlined };
		observations.reply.detail = isExact ? 'reply matches the sample' : 'reply differs from the sample';
		return isExact && underlined.every((u) => u.missing === '');
	}, 300000);
	report.valid = { sample: observations.reply?.isExact === true };
	// Every later step reads the sample reply.
	if (observations.reply?.reply === undefined) throw new Error('the sample reply was never drawn');
	await sleep(600);

	await step('drag-lead-in', 'Drag across “merged 3 days”: those words are selected and copied, and the stretch stays closed', () =>
		copyGesture('merged 3 days', (at) => drag(at.row, at.col, at.col + at.len - 1)), () => {
		const { copied, isOpened } = copyOutcome('drag-lead-in', /e2e run passed/);
		return copied === 'merged 3 days' && !isOpened;
	}, 1500);
	await pointerAway();

	await step('click-lead-in', 'Click “approved”: its stretch opens', async () => {
		const at = locate('approved');
		if (at === undefined) return false;
		observations['click-lead-in'] = {};
		await click(at.row, at.col + 4);
	}, () => {
		const isOpen = /but a failing e2e test blocks it\.\s*«/.test(collapsed(text()));
		const press = pointer.filter((p) => p.button === 0 && !p.up).at(-1);
		// The first screen after the press whose period after "approved" has gone: the growth has begun.
		const grown = frames.find((f) => f.t > (press?.t ?? 0) && !/approved\./.test(plainRows(parseScreen(f.screen)).join('\n')));
		const delay = grown === undefined || press === undefined ? null : grown.t - press.t;
		Object.assign(observations['click-lead-in'], { isOpen, delay, detail: isOpen ? `opened ${delay?.toFixed(2)} s after the press` : 'did not open' });
		return isOpen;
	}, 8000);
	await settle(600);

	await step('double-click-lead-in', 'Double-click “hooks/reply.tsx”: that word is selected and copied, and its stretch stays closed', () =>
		copyGesture('hooks/reply.tsx', (at) => doubleClick(at.row, at.col + 7)), () => {
		const presses = pointer.filter((p) => p.button === 0 && !p.up).slice(-2);
		const pressGap = presses.length === 2 ? presses[1].t - presses[0].t : null;
		const { copied, isOpened } = copyOutcome('double-click-lead-in', /then rerun the tests/, { pressGap });
		return copied === 'hooks/reply.tsx' && !isOpened;
	}, 1500);
	report.valid.doubleClick = (observations['double-click-lead-in']?.pressGap ?? 1) < 0.45;
	await pointerAway();

	await step('comma', 'The whole sentence “Retries wait 200, 400 and 800 ms” is underlined, back past its commas', () => {}, () => {
		const at = locate('Retries wait 200, 400 and 800 ms');
		if (at === undefined) return false;
		const missing = notUnderlined(at);
		const underlined = underlinedOn(at.row);
		observations.comma = { underlined, missing, detail: `underlined: “${underlined}”` };
		return missing === '';
	}, 1000);

	await step('apart', 'Between “the tests” and “then merge” the space is not underlined: two links, drawn apart', () => {}, () => {
		const tests = locate('the tests then merge');
		if (tests === undefined) return false;
		const short = { row: tests.row, col: tests.col, len: 9 };
		const leadIn = { row: tests.row, col: tests.col + 10, len: 10 };
		const space = { row: tests.row, col: tests.col + 9, len: 1 };
		const isSpaceUnderlined = isUnderlined(space.row, space.col);
		const underlined = underlinedOn(tests.row);
		observations.apart = { underlined, isSpaceUnderlined, missing: notUnderlined(short) + notUnderlined(leadIn), detail: isSpaceUnderlined ? 'the space is underlined: one unbroken line' : 'the space is not underlined' };
		return !isSpaceUnderlined && notUnderlined(short) === '' && notUnderlined(leadIn) === '';
	}, 1000);

	await step('drag-short', 'Drag across the short form “the tests”: it is selected and copied, and its stretch stays closed', () =>
		copyGesture('the tests then', (at) => drag(at.row, at.col, at.col + 8)), () => {
		const { copied, isOpened } = copyOutcome('drag-short', /the unit tests/);
		return copied === 'the tests' && !isOpened;
	}, 1500);
	await pointerAway();

	let firstPress = 0;
	await step('grow', 'Click “The fix is one line.”, then “exited” about 0.15 s later: while the fix grows, “The type check exited 0” stays underlined, and both stretches open', async () => {
		const fix = locate('The fix is one line.');
		const exited = locate('exited 0.');
		if (fix === undefined || exited === undefined) return false;
		observations.grow = {};
		firstPress = now();
		await click(fix.row, fix.col + 4);
		await sleep(60);
		await click(exited.row, exited.col + 2);
		await settle(2500, 800, 12000);
	}, () => {
		const all = collapsed(text());
		const isFixOpen = /where the cache key now hashes the lockfile as well as `?package\.json`?\.\s*«/.test(all);
		const isCheckOpen = /exited 0, so it found no errors/.test(all);
		const since = frames.filter((f) => f.t >= firstPress).map((f) => ({ t: f.t, parsed: parseScreen(f.screen) }));
		since.forEach((f) => { f.text = plainRows(f.parsed).join('\n'); });
		// The type check has begun to open once its period no longer follows "exited 0".
		const checkOpening = since.find((f) => /exited 0(?!\.)/.test(f.text));
		// Every screen from the first press on in which the type check is still closed and the fix is
		// growing, begun and not yet whole: its lead-in words must be underlined in each. An opening stretch adds no word
		// for its first frames, so it draws "exited 0." without the link's underline, as it should for
		// an open one: screens up to 150 ms before the type check's words first show are left out.
		const isFixWhole = (f) => /as well as `?package\.json`?\.\s*«/.test(collapsed(f.text));
		const during = since.filter((f) => /exited 0\./.test(f.text) && !/The fix is one line\./.test(f.text) && !isFixWhole(f));
		const counted = during.filter((f) => checkOpening === undefined || f.t < checkOpening.t - 0.15);
		const bare = counted.filter(({ parsed }) => {
			const r = plainRows(parsed).findIndex((x) => x.includes('The type check exited 0'));
			return r < 0 || notUnderlined({ row: r, col: plainRows(parsed)[r].indexOf('The type check exited 0'), len: 23 }, parsed) !== '';
		});
		const presses = pointer.filter((p) => p.button === 0 && !p.up && p.t >= firstPress).slice(0, 2);
		Object.assign(observations.grow, {
			pressGap: presses.length === 2 ? presses[1].t - presses[0].t : null,
			isFixOpen, isCheckOpen, screensWhileGrowing: counted.length, screensWithoutUnderline: bare.length, screensLeftOutAtOpening: during.length - counted.length,
			bareAt: bare.map((f) => f.t), checkOpeningAt: checkOpening?.t ?? null,
			detail: `underlined on ${counted.length - bare.length} of ${counted.length} screens while the fix grew · ${isCheckOpen ? 'both opened' : 'the type check stayed closed'}`,
		});
		return isFixOpen && isCheckOpen && counted.length >= 2 && bare.length === 0;
	}, 1500);
	report.valid.growth = (observations.grow?.screensWhileGrowing ?? 0) >= 2;
	await pointerAway();

	await step('note', 'Type “note”: Claude quotes the plugin’s note, which names each lone period by the words before it', async () => {
		const before = turnsDone(text());
		await submit('note');
		await waitFor(() => turnsDone(text()) > before, 240000);
	}, () => {
		const [from, end] = answerRange('note');
		if (from === end || end === rows().length) return false;
		const quote = collapsed(rows().slice(from, end).join(' '));
		// A code block may wrap a row inside a word, so the words are matched with every space left out.
		const solid = quote.replace(/\s/g, '');
		const has = (s) => solid.includes(s.replace(/\s/g, ''));
		const names = { approved: has('"The second one is approved."'), merged: has('"The PR merged 3 days ago."') };
		observations.note = { quote, names, isNote: /Stretchtext/.test(quote), detail: `${names.approved ? 'names “The second one is approved.”' : 'no “The second one is approved.”'} · ${names.merged ? 'names “The PR merged 3 days ago.”' : 'no “The PR merged 3 days ago.”'}` };
		return names.approved && names.merged;
	}, 3000);
	report.valid.note = observations.note?.isNote === true;
} catch (caught) {
	error = caught;
} finally {
	copy(keptClipboard);
	await live.finish(error);
	console.log('valid', JSON.stringify(report.valid));
	if (Object.values(report.valid ?? { sample: false }).includes(false)) {
		console.log('INVALID: a verdict above cannot be trusted; see report.valid');
		process.exitCode = 1;
	}
}
