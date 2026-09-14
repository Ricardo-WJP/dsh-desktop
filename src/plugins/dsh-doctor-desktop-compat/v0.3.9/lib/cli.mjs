#!/usr/bin/env node
import { h as resolveDshHome, m as profileIdentity } from "./paths-CSu3On3H.mjs";
import { a as rollbackTransaction, c as readJson, i as repairProfile, l as writeJsonAtomic, n as discoverRollbackProfile, o as snapshotProfile, s as appendJsonLine, t as diagnoseAndPlan, u as parseProfileManifest } from "./recover-CmqlhwlI.mjs";
import { chmod, copyFile, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname as dirname$1, join as join$1, resolve as resolve$1 } from "node:path/posix";
import { homedir } from "node:os";
import { createServer } from "node:net";
const DEFAULT_DOCTOR_POLICY = {
	fullProtection: true,
	autoRepair: false,
	autoMigrate: true
};
function isSupervisorRequest(value) {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value;
	return candidate.protocol === 1 && typeof candidate.type === "string";
}
//#endregion
//#region src/agent/dsh-process.ts
/** Build the exact cmd.exe argument vector required to execute a trusted .cmd shim. */
function windowsCmdShimArgs(binary, args) {
	const unsafe = /[&|<>"'`%!\n\r\0]/;
	if (/["%\n\r\0]/.test(binary) || args.some((arg) => unsafe.test(arg))) throw new Error("doctor: unsafe Windows command argument");
	return [
		"/d",
		"/s",
		"/c",
		"\"\"" + binary + "\" " + args.map((arg) => "\"" + arg + "\"").join(" ") + "\""
	];
}
/** Return a platform-specific command without enabling general shell parsing. */
function dshSpawnSpec(binary, args, platform = process.platform) {
	if (platform === "win32") {
		if (binary.toLowerCase().endsWith(".cmd") || binary.toLowerCase().endsWith(".bat")) return {
			command: "cmd.exe",
			args: windowsCmdShimArgs(binary, args),
			windowsVerbatimArguments: true
		};
		if (binary.toLowerCase().endsWith(".js") || binary.toLowerCase().endsWith(".mjs") || binary.toLowerCase().endsWith(".cjs")) return {
			command: process.execPath,
			args: [binary, ...args]
		};
	}
	return {
		command: binary,
		args: [...args]
	};
}
/** Spawn the official DSH CLI, including the Windows .cmd shim path. */
function spawnDsh(binary, args, options, platform = process.platform) {
	const spec = dshSpawnSpec(binary, args, platform);
	return spawn(spec.command, spec.args, {
		...options,
		...spec.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}
	});
}
//#endregion
//#region src/agent/legacy-migration.ts
/**
* Deterministic mapping for the dsh-web aggregate package rename.
*
* The runtime identifiers (web-ui-* rows, settings section, API paths,
* storage keys) stay frozen; only the npm aggregate package name changes.
* This module is the single migration map shared by the plugin-manager
* update job and the Doctor preflight launcher so they never drift.
*/
/** The previously published aggregate package name. */
const LEGACY_AGGREGATE = "@linxin666/dsh-web-ui-all";
/** The current aggregate package name. */
const CURRENT_AGGREGATE = "@linxin666/dsh-web-all";
/** Whether a package name is the legacy aggregate. */
function isLegacyAggregate(name) {
	return name === LEGACY_AGGREGATE;
}
/**
* Build the exact target install spec for one legacy aggregate source.
*
* Local repository links are rewritten in place so development checkouts
* keep using the repository tree; every other source is migrated through the
* published package pinned to the family release version.
*/
function targetSpecForLegacy(sourceSpec, familyVersion) {
	const raw = sourceSpec.trim();
	if (raw.startsWith("link:") || raw.startsWith("file:")) {
		const prefix = raw.slice(0, raw.indexOf(":"));
		const target = raw.slice(prefix.length + 1);
		const index = target.lastIndexOf("dsh-web-ui-all");
		if (index === -1) return void 0;
		return `${prefix}:${target.slice(0, index) + "dsh-web-all" + target.slice(index + 14)}`;
	}
	if (familyVersion === "") return void 0;
	return `${CURRENT_AGGREGATE}@${familyVersion}`;
}
//#endregion
//#region src/agent/version.ts
/**
* Package version identity for the machine-side halves.
*
* The version always comes from the package.json next to the compiled module
* (one level above lib/ for built bundles and src/ for repo runs), so a
* published bump is picked up without touching hardcoded literals. The
* Supervisor reports this version and the CLI pins the rescue-capsule install
* spec to it; the Web console compares it with the host half's own version to
* detect a stale Supervisor after an update.
* @module @linxin666/dsh-doctor/agent
*/
/** Read the version of the package owning a module file. */
function packageVersionAt(moduleFilePath) {
	try {
		const raw = JSON.parse(readFileSync(join(dirname(moduleFilePath), "..", "package.json"), "utf8"));
		if (typeof raw.version === "string" && raw.version !== "") return raw.version;
	} catch {}
	return "0.0.0";
}
/** Version of the package the current module belongs to (bundled-aware). */
function currentPackageVersion() {
	return packageVersionAt(fileURLToPath(import.meta.url));
}
//#endregion
//#region src/agent/migrate.ts
/**
* Doctor launch-time migration for the legacy aggregate package.
*
* The Doctor Launcher runs before the real DSH process so a stale
* `@linxin666/dsh-web-ui-all` profile can be migrated to
* `@linxin666/dsh-web-all` without user interaction. Every mutation goes
* through the official `dsh plugin` CLI and is backed up before it starts.
* The legacy package stays in place until the current aggregate is installed
* and verified; a failed migration restores the original manifest when
* possible and never leaves both aggregates mounted as boot layers.
*/
const REGISTRY_TIMEOUT_MS = 1e4;
const CLI_TIMEOUT_MS = 6 * 6e4;
/** Build the full old package spec from the profile's recorded dependency spec. */
function fullLegacySpec(name, spec) {
	if (/^(?:link:|file:|git:|git\+|github:|https?:\/\/|npm:)/.test(spec)) return spec;
	if (spec === "") return name;
	return `${name}@${spec}`;
}
/** Move the current aggregate into the legacy package's old layer position. */
async function moveBundle(packageJsonPath, oldIndex, target) {
	const text = await readFile(packageJsonPath, "utf8");
	const parsed = JSON.parse(text);
	const profile = parsed.dsh?.profile;
	if (profile === void 0 || !Array.isArray(profile.bundles)) return;
	const bundles = profile.bundles.filter((entry) => typeof entry === "string");
	const current = bundles.indexOf(target);
	if (current >= 0) bundles.splice(current, 1);
	bundles.splice(Math.max(0, Math.min(oldIndex, bundles.length)), 0, target);
	profile.bundles = bundles;
	await writeJsonAtomic(packageJsonPath, parsed, 384);
}
/** Copy a backup for the manifest and lockfile before migration. */
async function backupProfile(packageJsonPath, lockfilePath, stamp) {
	await copyFile(packageJsonPath, `${packageJsonPath}.bak-doctor-migrate-${stamp}`).catch(() => void 0);
	await copyFile(lockfilePath, `${lockfilePath}.bak-doctor-migrate-${stamp}`).catch(() => void 0);
}
/** Restore the manifest/lockfile backup after a failed migration. */
async function restoreBackup(packageJsonPath, lockfilePath, stamp) {
	await copyFile(`${packageJsonPath}.bak-doctor-migrate-${stamp}`, packageJsonPath).catch(() => void 0);
	await copyFile(`${lockfilePath}.bak-doctor-migrate-${stamp}`, lockfilePath).catch(() => void 0);
}
/** Ensure the current package can be installed before touching the profile. */
async function targetAvailable(targetSpec, profileDir, deps) {
	if (targetSpec.startsWith("link:") || targetSpec.startsWith("file:")) {
		const rawPath = targetSpec.slice(targetSpec.indexOf(":") + 1);
		const path = isAbsolute(rawPath) ? rawPath : resolve(profileDir, rawPath);
		return (deps.exists ?? existsSync)(join(path, "package.json"));
	}
	const targetVersion = deps.targetVersion ?? currentPackageVersion();
	const encoded = "@linxin666%2Fdsh-web-all";
	const fetchImpl = deps.fetch ?? (async (url) => await fetch(url, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) }));
	try {
		const response = await fetchImpl(`https://registry.npmjs.org/${encoded}/${targetVersion}`);
		if (!response.ok) return false;
		return (await response.json()).version === targetVersion;
	} catch {
		return false;
	}
}
/**
* Run the deterministic legacy aggregate migration through the official CLI.
* Returns noop when there is nothing to migrate or the current package is not
* yet available; returns error with a diagnostic message otherwise.
*/
async function migrateLegacyAggregate(home, profile, dshPath, options = {}) {
	const env = options.env ?? process.env;
	const profileDir = join(home, "profiles", profile);
	const packageJsonPath = join(profileDir, "package.json");
	const lockfilePath = join(profileDir, "pnpm-lock.yaml");
	let manifestText;
	try {
		manifestText = await readFile(packageJsonPath, "utf8");
	} catch {
		return {
			kind: "noop",
			message: "profile package.json not found"
		};
	}
	const parsed = parseProfileManifest(manifestText, packageJsonPath);
	if (parsed.error !== void 0) return {
		kind: "error",
		message: parsed.error
	};
	const legacyName = "@linxin666/dsh-web-ui-all";
	const currentName = "@linxin666/dsh-web-all";
	const oldSpec = parsed.facts.dependencies[legacyName];
	if (oldSpec === void 0 || !isLegacyAggregate(legacyName)) return {
		kind: "noop",
		message: "legacy aggregate is not installed"
	};
	const targetVersion = options.targetVersion ?? currentPackageVersion();
	const targetSpec = targetSpecForLegacy(oldSpec, targetVersion);
	if (targetSpec === void 0 || !await targetAvailable(targetSpec, profileDir, options)) return {
		kind: "noop",
		message: "current aggregate is not available yet"
	};
	const oldIndex = parsed.facts.bundles.indexOf(legacyName);
	const targetPreviouslyInstalled = parsed.facts.dependencies[currentName] !== void 0;
	const stamp = (options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString().replace(/[^0-9]/g, "")))().slice(0, 14);
	await backupProfile(packageJsonPath, lockfilePath, stamp);
	try {
		const run = options.run ?? (async (args, runEnv) => {
			return await new Promise((resolve, reject) => {
				const child = spawnDsh(dshPath, args, {
					env: runEnv,
					stdio: [
						"ignore",
						"pipe",
						"pipe"
					]
				});
				let output = "";
				child.stdout?.on("data", (chunk) => {
					output = (output + chunk.toString()).slice(-32e3);
				});
				child.stderr?.on("data", (chunk) => {
					output = (output + chunk.toString()).slice(-32e3);
				});
				const timer = setTimeout(() => {
					child.kill();
				}, CLI_TIMEOUT_MS);
				child.once("error", reject);
				child.once("close", (code) => {
					clearTimeout(timer);
					resolve({
						code,
						output
					});
				});
			});
		});
		const cliEnv = {
			...env,
			DSH_HOME: home,
			DSH_TELEMETRY_DISABLED: "1"
		};
		const addTarget = async () => run([
			"plugin",
			"--profile",
			profile,
			"add",
			targetSpec
		], cliEnv);
		const removeLegacy = async () => run([
			"plugin",
			"--profile",
			profile,
			"remove",
			legacyName
		], cliEnv);
		const addLegacy = async () => run([
			"plugin",
			"--profile",
			profile,
			"add",
			fullLegacySpec(legacyName, oldSpec)
		], cliEnv);
		let addedTarget = false;
		const targetIsLocal = /^(?:link:|file:)/.test(targetSpec);
		if (!targetPreviouslyInstalled) {
			const add = await addTarget();
			if (add.code !== 0) {
				await restoreBackup(packageJsonPath, lockfilePath, stamp);
				return {
					kind: "error",
					message: `doctor: install ${targetSpec} failed${add.output === "" ? "" : `: ${add.output}`}`
				};
			}
			addedTarget = true;
		} else if (!targetIsLocal) {
			const add = await addTarget();
			if (add.code !== 0) {
				await restoreBackup(packageJsonPath, lockfilePath, stamp);
				return {
					kind: "error",
					message: `doctor: update ${targetSpec} failed${add.output === "" ? "" : `: ${add.output}`}`
				};
			}
		}
		const remove = await removeLegacy();
		if (remove.code !== 0) {
			if (addedTarget) await run([
				"plugin",
				"--profile",
				profile,
				"remove",
				currentName
			], cliEnv);
			await restoreBackup(packageJsonPath, lockfilePath, stamp);
			return {
				kind: "error",
				message: `doctor: remove ${legacyName} failed${remove.output === "" ? "" : `: ${remove.output}`}`
			};
		}
		await moveBundle(packageJsonPath, oldIndex, currentName);
		const verify = await run([
			"--profile",
			profile,
			"--dump-config"
		], cliEnv);
		if (verify.code !== 0) {
			if (addedTarget) await run([
				"plugin",
				"--profile",
				profile,
				"remove",
				currentName
			], cliEnv);
			if (!targetPreviouslyInstalled) {
				if ((await addLegacy()).code !== 0) await restoreBackup(packageJsonPath, lockfilePath, stamp);
				else if (oldIndex >= 0) await moveBundle(packageJsonPath, oldIndex, legacyName);
			}
			return {
				kind: "error",
				message: `doctor: migrated profile failed the dump gate${verify.output === "" ? "" : `: ${verify.output}`}`
			};
		}
		return {
			kind: "migrated",
			message: `migrated ${legacyName} to ${targetSpec}`,
			targetSpec,
			targetVersion
		};
	} catch (error) {
		await restoreBackup(packageJsonPath, lockfilePath, stamp).catch(() => void 0);
		return {
			kind: "error",
			message: `doctor: legacy migration failed: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}
//#endregion
//#region src/agent/ipc.ts
function createSupervisorToken() {
	return randomBytes(32).toString("hex");
}
function tokensEqual(actual, expected) {
	const a = Buffer.from(actual);
	const b = Buffer.from(expected);
	return a.length === b.length && timingSafeEqual(a, b);
}
async function ensureToken(path) {
	try {
		return (await readFile(path, "utf8")).trim();
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const token = createSupervisorToken();
		await mkdir(dirname$1(path), {
			recursive: true,
			mode: 448
		});
		await writeFile(path, token, {
			mode: 384,
			flag: "wx"
		});
		await chmod(path, 384).catch(() => {});
		return token;
	}
}
async function callSupervisor(endpoint, token, request, timeoutMs = 3e3) {
	const body = JSON.stringify({
		token,
		request
	});
	if (endpoint.startsWith("http://") || endpoint.startsWith("https://")) return await (await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		signal: AbortSignal.timeout(timeoutMs)
	})).json();
	const { createConnection } = await import("node:net");
	return await new Promise((resolve, reject) => {
		const socket = createConnection(endpoint);
		let received = "";
		const timer = setTimeout(() => {
			socket.destroy(/* @__PURE__ */ new Error("doctor: supervisor timeout"));
		}, timeoutMs);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(body + "\n");
		});
		socket.on("data", (chunk) => {
			received += chunk;
		});
		socket.on("end", () => {
			clearTimeout(timer);
			try {
				resolve(JSON.parse(received));
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}
//#endregion
//#region src/agent/launch.ts
/** Drop a leading program token (`dsh`, `dsh.cmd`, absolute executable path) so helpers work with or without it. */
function normalizeArgv(argv) {
	const first = argv[0];
	if (first !== void 0 && /^dsh(\.(cmd|exe|ps1|sh))?$/.test(first)) return argv.slice(1);
	if (first !== void 0 && first.includes("/") && first.includes("dsh")) return argv.slice(1);
	return argv;
}
function parseProfile(argv) {
	const args = normalizeArgv(argv);
	const index = args.indexOf("--profile");
	if (index >= 0) return args[index + 1];
	return args[0] === "web" ? "web" : void 0;
}
function classifyInvocation(argv) {
	const args = normalizeArgv(argv);
	if (args.includes("--version") || args.includes("-V") || args.includes("--help") || args.includes("-h")) return "utility";
	if (args[0] === "plugin") return "plugin";
	if (args.includes("--dump-config") || args.includes("--dump-default-config")) return "dump";
	return "profile";
}
function findRealDsh(env = process.env, self = process.argv[1]) {
	const explicit = env.DSH_DOCTOR_REAL_DSH?.trim();
	if (explicit) return realpathSync(explicit);
	const selfDir = self ? dirname$1(resolve$1(self)) : "";
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (!directory || resolve$1(directory) === selfDir) continue;
		const candidate = resolve$1(directory, process.platform === "win32" ? "dsh.cmd" : "dsh");
		try {
			return realpathSync(candidate);
		} catch {}
	}
	throw new Error("doctor: cannot locate the real dsh executable; set DSH_DOCTOR_REAL_DSH");
}
async function managedLaunch(options) {
	const env = options.env ?? process.env;
	const realDsh = options.realDsh ?? findRealDsh(env);
	const kind = classifyInvocation(options.argv);
	const profileName = parseProfile(options.argv);
	const identity = profileName === void 0 ? void 0 : profileIdentity(resolveDshHome(env), profileName, realDsh);
	if (kind === "profile" && profileName !== void 0 && options.autoMigrate !== false) try {
		const migration = await migrateLegacyAggregate(resolveDshHome(env), profileName, realDsh, { env });
		if (migration.kind === "migrated") process.stderr.write(`[doctor] ${migration.message}\n`);
		if (migration.kind === "error") process.stderr.write(`[doctor] ${migration.message}\n`);
	} catch (error) {
		process.stderr.write(`[doctor] legacy aggregate migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
	}
	const runId = randomUUID();
	const child = spawnDsh(realDsh, options.argv, {
		stdio: [
			"inherit",
			"inherit",
			"pipe"
		],
		env: {
			...env,
			DSH_DOCTOR_ENDPOINT: options.endpoint,
			DSH_DOCTOR_TOKEN: options.token,
			DSH_DOCTOR_RUN_ID: runId,
			...identity ? { DSH_DOCTOR_PROFILE_ID: identity.id } : {}
		}
	});
	let tail = "";
	child.stderr?.on("data", (chunk) => {
		process.stderr.write(chunk);
		tail = (tail + chunk.toString("utf8")).slice(-32e3);
	});
	if (kind === "profile" && identity) {
		const request = {
			protocol: 1,
			type: "launcher-start",
			profile: identity,
			runId,
			pid: child.pid ?? -1,
			argv: [...options.argv],
			at: (options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))()
		};
		await callSupervisor(options.endpoint, options.token, request).catch(() => void 0);
	}
	let interrupted = false;
	const forward = (signal) => {
		interrupted = true;
		child.kill(signal);
	};
	process.once("SIGINT", forward);
	process.once("SIGTERM", forward);
	const result = await new Promise((resolve) => child.once("close", (code, signal) => resolve({
		code,
		signal
	})));
	process.removeListener("SIGINT", forward);
	process.removeListener("SIGTERM", forward);
	if (kind === "profile" && identity) await callSupervisor(options.endpoint, options.token, {
		protocol: 1,
		type: "launcher-exit",
		profileId: identity.id,
		runId,
		exitCode: result.code,
		signal: result.signal,
		intentional: interrupted,
		started: tail.includes("dsh web:"),
		at: (options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))(),
		stderrTail: tail
	}).catch(() => void 0);
	if (result.signal === "SIGINT") return 130;
	if (result.signal === "SIGTERM") return 143;
	return result.code ?? 1;
}
//#endregion
//#region src/agent/paths.ts
function doctorPaths(env = process.env, home = homedir()) {
	const raw = env.DSH_DOCTOR_HOME?.trim();
	const isPosix = raw && raw.startsWith("/") || !raw && home.startsWith("/");
	const res = isPosix ? resolve$1 : resolve;
	const j = isPosix ? join$1 : join;
	const root = res(raw && raw !== "" ? raw : j(home, ".dsh-doctor"));
	return {
		root,
		state: j(root, "state"),
		registry: j(root, "registry"),
		incidents: j(root, "incidents"),
		snapshots: j(root, "snapshots"),
		candidates: j(root, "candidates"),
		quarantine: j(root, "quarantine"),
		capsule: j(root, "capsule"),
		logs: j(root, "logs"),
		socket: process.platform === "win32" ? `\\\\.\\pipe\\dsh-doctor-${createHash("sha256").update(root).digest("hex").slice(0, 16)}` : j(root, "state", "supervisor.sock"),
		token: j(root, "state", "supervisor.token")
	};
}
//#endregion
//#region src/agent/capsule.ts
/**
* Known credential-bearing file names mirrored into the rescue profile so the
* isolated environment can actually run providers after a crash. Only the
* canonical names are mirrored; backup variants (name.bak-*) are never copied.
*/
const CREDENTIAL_BASENAMES = [
	"settings.yaml",
	".credentials.yaml",
	"credentials.yaml",
	"credentials.yml",
	".env"
];
/** Candidate mirror paths relative to the DSH home. */
function credentialRelPaths(sourceProfile) {
	const profileLevel = CREDENTIAL_BASENAMES.map((name) => join("profiles", sourceProfile, name));
	return [...CREDENTIAL_BASENAMES, ...profileLevel];
}
async function exists(path) {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}
/** Copy every existing credential-bearing file into the rescue home (0600). */
async function mirrorCredentialFiles(options) {
	const mirrored = [];
	for (const rel of credentialRelPaths(options.sourceProfile)) {
		const from = join(options.sourceHome, rel);
		if (!await exists(from)) continue;
		const to = join(options.targetHome, rel);
		await mkdir(resolve(to, ".."), {
			recursive: true,
			mode: 448
		});
		await cp(from, to);
		await chmod(to, 384);
		mirrored.push(rel);
	}
	return mirrored;
}
/** Sha256 fingerprint of the credential-bearing source files (sorted by path). */
async function credentialsFingerprint(sourceHome, sourceProfile) {
	const hash = createHash("sha256");
	for (const rel of credentialRelPaths(sourceProfile)) try {
		hash.update(rel);
		hash.update(Buffer.from([0]));
		hash.update(await readFile(join(sourceHome, rel)));
	} catch {}
	return hash.digest("hex");
}
/** Remove the mirrored credential files recorded in the capsule manifest (best effort). */
async function removeCapsuleCredentialFiles(paths) {
	let manifest;
	try {
		manifest = JSON.parse(await readFile(join(paths.capsule, "current", "manifest.json"), "utf8"));
	} catch {
		return { removed: 0 };
	}
	const rescueHome = manifest.rescueHome;
	if (typeof rescueHome !== "string" || rescueHome === "") return { removed: 0 };
	let removed = 0;
	for (const rel of manifest.credentialsMirror ?? []) try {
		await rm(join(rescueHome, rel), { force: true });
		removed += 1;
	} catch {}
	return { removed };
}
async function run(command, args, env, timeoutMs = 6 * 6e4) {
	return await new Promise((resolvePromise, reject) => {
		const child = spawnDsh(command, args, {
			env,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			]
		});
		let stdout = "", stderr = "";
		child.stdout.on("data", (b) => {
			stdout += b;
		});
		child.stderr.on("data", (b) => {
			stderr += b;
		});
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timer);
			resolvePromise({
				code: code ?? 1,
				stdout,
				stderr
			});
		});
	});
}
async function provisionCapsule(options) {
	const current = join(options.paths.capsule, "current");
	const staging = join(options.paths.capsule, "staging-" + process.pid + "-" + Date.now());
	const previous = join(options.paths.capsule, "previous");
	await rm(staging, {
		recursive: true,
		force: true
	});
	await mkdir(staging, {
		recursive: true,
		mode: 448
	});
	const rescueHome = join(staging, "rescue-home");
	const env = {
		...process.env,
		DSH_HOME: rescueHome,
		DSH_TELEMETRY_DISABLED: "1"
	};
	const executor = options.run ?? run;
	const version = await executor(options.dshExecutable, ["--version"], env);
	if (version.code !== 0) throw new Error("doctor: cannot probe dsh: " + version.stderr);
	const doctorSpec = options.doctorPackageDir ? "link:" + resolve(options.doctorPackageDir) : options.doctorSpec;
	const install = await executor(options.dshExecutable, [
		"plugin",
		"--profile",
		"web",
		"add",
		doctorSpec
	], env);
	if (install.code !== 0) throw new Error("doctor: rescue Doctor install failed: " + install.stderr);
	const dump = await executor(options.dshExecutable, [
		"--profile",
		"web",
		"--dump-config"
	], env);
	if (dump.code !== 0 || !dump.stdout.includes("doctor")) throw new Error("doctor: rescue profile verification failed: " + dump.stderr);
	let credentialsMirror;
	let fingerprint;
	if (options.mirrorCredentials !== false && options.sourceHome !== void 0 && options.sourceHome !== "") {
		credentialsMirror = await mirrorCredentialFiles({
			sourceHome: options.sourceHome,
			sourceProfile: options.sourceProfile ?? "web",
			targetHome: rescueHome
		});
		if (credentialsMirror.length > 0) fingerprint = await credentialsFingerprint(options.sourceHome, options.sourceProfile ?? "web");
	}
	const now = (options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString()))();
	const manifest = {
		schemaVersion: 1,
		createdAt: now,
		dshExecutable: resolve(options.dshExecutable),
		dshVersion: version.stdout.trim(),
		doctorPackage: doctorSpec,
		...options.doctorVersion !== void 0 ? { doctorVersion: options.doctorVersion } : {},
		...credentialsMirror !== void 0 && credentialsMirror.length > 0 ? {
			credentialsMirror,
			credentialsFingerprint: fingerprint,
			credentialsAt: now
		} : {},
		rescueHome,
		status: "verified"
	};
	await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 384 });
	await rm(previous, {
		recursive: true,
		force: true
	});
	try {
		await rename(current, previous);
	} catch {}
	await rename(staging, current);
	manifest.rescueHome = join(current, "rescue-home");
	await writeFile(join(current, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 384 });
	return manifest;
}
//#endregion
//#region src/agent/state.ts
function emptyState() {
	return {
		phase: "disabled",
		profiles: {},
		incidents: {},
		recentFailures: {},
		paused: false,
		policy: { ...DEFAULT_DOCTOR_POLICY }
	};
}
function snapshotOf(state, version, now = (/* @__PURE__ */ new Date()).toISOString()) {
	return {
		protocol: 1,
		phase: state.phase,
		version,
		capsuleVersion: state.capsuleVersion,
		degradedReason: state.degradedReason,
		policy: { ...state.policy ?? DEFAULT_DOCTOR_POLICY },
		profiles: Object.values(state.profiles),
		incidents: Object.values(state.incidents).sort((a, b) => b.openedAt.localeCompare(a.openedAt)),
		updatedAt: now
	};
}
function upsertProfile(state, identity) {
	const current = state.profiles[identity.id] ?? {
		identity,
		phase: "idle",
		restartCount: 0,
		managed: true
	};
	current.identity = identity;
	state.profiles[identity.id] = current;
	return current;
}
function openIncident(state, profileId, kind, summary, evidence, now) {
	const active = Object.values(state.incidents).find((item) => item.profileId === profileId && ![
		"recovered",
		"rolled-back",
		"unresolved"
	].includes(item.phase));
	if (active) {
		active.updatedAt = now;
		const merged = evidence.length > 0 ? evidence : [summary];
		active.evidence = [.../* @__PURE__ */ new Set([...active.evidence, ...merged])];
		return active;
	}
	const incident = {
		id: randomUUID(),
		profileId,
		kind,
		phase: "opened",
		openedAt: now,
		updatedAt: now,
		summary,
		evidence: evidence.length > 0 ? evidence : [summary],
		repairable: true
	};
	state.incidents[incident.id] = incident;
	return incident;
}
function recordFailure(state, profileId, at, windowMs = 10 * 6e4) {
	const cutoff = Date.parse(at) - windowMs;
	const retained = (state.recentFailures[profileId] ?? []).filter((value) => Date.parse(value) >= cutoff);
	retained.push(at);
	state.recentFailures[profileId] = retained;
	return retained.length;
}
//#endregion
//#region src/agent/supervisor.ts
var DoctorSupervisor = class {
	paths;
	state = emptyState();
	token = "";
	server;
	sweep;
	version;
	now;
	heartbeatTimeoutMs;
	provisioner;
	provisioning = false;
	constructor(options = {}) {
		this.paths = options.paths ?? doctorPaths();
		this.version = options.version ?? currentPackageVersion();
		this.now = options.now ?? (() => (/* @__PURE__ */ new Date()).toISOString());
		this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 15e3;
		this.provisioner = options.provisioner;
	}
	async start() {
		await mkdir(this.paths.state, {
			recursive: true,
			mode: 448
		});
		this.token = await ensureToken(this.paths.token);
		this.state = await readJson(join$1(this.paths.state, "supervisor.json"), emptyState());
		this.state.policy = await readJson(join$1(this.paths.state, "policy.json"), this.state.policy ?? DEFAULT_DOCTOR_POLICY);
		this.state.phase = this.state.paused ? "disabled" : "armed";
		if (process.platform !== "win32") await rm(this.paths.socket, { force: true });
		this.server = createServer({ allowHalfOpen: true }, (socket) => {
			socket.setEncoding("utf8");
			let body = "";
			let handled = false;
			const respond = (value) => {
				if (socket.destroyed || socket.writableEnded) return;
				socket.end(JSON.stringify(value));
			};
			socket.on("data", (chunk) => {
				body += chunk;
				if (body.length > 256 * 1024) socket.destroy(/* @__PURE__ */ new Error("doctor: IPC body too large"));
				if (!handled && body.includes("\n")) {
					handled = true;
					this.handleWire(body).then(respond, (error) => respond({
						ok: false,
						error: {
							code: "INTERNAL",
							message: String(error)
						}
					}));
				}
			});
			socket.on("error", () => void 0);
			socket.on("end", () => {
				if (!handled) {
					handled = true;
					this.handleWire(body).then(respond, (error) => respond({
						ok: false,
						error: {
							code: "INTERNAL",
							message: String(error)
						}
					}));
				}
			});
		});
		await new Promise((resolvePromise, reject) => {
			this.server.once("error", reject);
			this.server.listen(this.paths.socket, () => resolvePromise());
		});
		this.sweep = setInterval(() => {
			this.sweepHeartbeats();
		}, 5e3);
		this.sweep.unref?.();
		await this.persist();
	}
	async stop() {
		if (this.sweep) clearInterval(this.sweep);
		if (this.server) await new Promise((resolvePromise) => this.server.close(() => resolvePromise()));
		if (process.platform !== "win32") await rm(this.paths.socket, { force: true });
		await this.persist();
	}
	async handleWire(body) {
		let envelope;
		try {
			envelope = JSON.parse(body.trim());
		} catch {
			return {
				ok: false,
				error: {
					code: "INVALID_JSON",
					message: "Invalid request"
				}
			};
		}
		if (!tokensEqual(envelope.token ?? "", this.token)) return {
			ok: false,
			error: {
				code: "UNAUTHORIZED",
				message: "Invalid token"
			}
		};
		if (!isSupervisorRequest(envelope.request)) return {
			ok: false,
			error: {
				code: "INVALID_REQUEST",
				message: "Unsupported request"
			}
		};
		return this.handle(envelope.request);
	}
	async handle(request) {
		const at = this.now();
		if (request.type === "status") return {
			ok: true,
			snapshot: snapshotOf(this.state, this.version, at)
		};
		if (request.type === "policy") {
			this.state.policy = {
				fullProtection: request.policy.fullProtection,
				autoRepair: request.policy.autoRepair,
				autoMigrate: request.policy.autoMigrate
			};
			for (const profile of Object.values(this.state.profiles)) profile.managed = request.policy.fullProtection;
		} else if (request.type === "launcher-start") {
			if (request.profile.role === "rescue") return {
				ok: true,
				snapshot: snapshotOf(this.state, this.version, at)
			};
			const profile = upsertProfile(this.state, request.profile);
			Object.assign(profile, {
				phase: "starting",
				pid: request.pid,
				runId: request.runId,
				command: request.argv,
				startedAt: request.at,
				managed: this.state.policy.fullProtection
			});
		} else if (request.type === "heartbeat") {
			const profile = this.state.profiles[request.profileId];
			if (profile) Object.assign(profile, {
				phase: request.phase === "ready" ? "healthy" : request.phase === "degraded" ? "degraded" : "starting",
				pid: request.pid,
				runId: request.runId,
				lastHealthyAt: request.at
			});
		} else if (request.type === "launcher-exit") {
			const profile = this.state.profiles[request.profileId];
			if (profile) {
				profile.pid = void 0;
				profile.phase = request.intentional || request.exitCode === 0 ? "exited" : "failed";
				if (this.state.policy.fullProtection && !this.state.paused && !request.intentional && request.exitCode !== 0) {
					const failures = recordFailure(this.state, request.profileId, request.at);
					profile.restartCount = failures;
					if (failures >= 2) profile.phase = "quarantined";
					openIncident(this.state, request.profileId, request.started ? "process-crash" : "boot-failure", request.started ? "DSH process crashed after startup" : "DSH profile failed during startup", [request.stderrTail ?? ""].filter(Boolean), request.at);
				}
			}
		} else if (request.type === "client-failure") {
			if (this.state.policy.fullProtection && !this.state.paused) openIncident(this.state, request.profileId, "client-failure", request.message, [request.stack ?? "", request.phase ?? ""].filter(Boolean), request.at);
		} else if (request.type === "action") {
			if (request.action === "pause") {
				this.state.paused = true;
				this.state.phase = "disabled";
			} else if (request.action === "resume") {
				this.state.paused = false;
				this.state.phase = "armed";
			} else if (request.action === "provision") await this.startProvision();
			else if (request.action === "uninstall") {
				this.state.phase = "uninstalling";
				this.state.degradedReason = void 0;
				await this.cleanupCapsuleCredentials();
			} else if (request.incidentId) {
				const incident = this.state.incidents[request.incidentId];
				if (incident) {
					incident.phase = request.action === "rollback" ? "rolled-back" : request.action === "confirm" || request.action === "repair" ? "repairing" : request.action === "diagnose" ? "diagnosing" : incident.phase;
					if (request.action === "diagnose" || request.action === "repair" || request.action === "confirm" || request.action === "rollback") await this.runRecovery(request.action, request.incidentId, at);
				}
			}
		}
		await appendJsonLine(join$1(this.paths.logs, "journal.jsonl"), {
			at,
			request: request.type
		});
		await this.persist();
		return {
			ok: true,
			snapshot: snapshotOf(this.state, this.version, at)
		};
	}
	/**
	* Run the deterministic recovery workflow for one incident; records the outcome on the incident.
	*/
	async runRecovery(action, incidentId, at) {
		const incident = this.state.incidents[incidentId];
		const profile = this.state.profiles[incident?.profileId ?? ""];
		if (incident === void 0 || profile === void 0) return;
		try {
			const request = {
				home: profile.identity.dshHome,
				profile: profile.identity.name,
				dshPath: profile.identity.dshExecutable
			};
			const { confirmRepair, diagnoseAndPlan, repairProfile, rollbackTransaction } = await import("./recover-CmqlhwlI.mjs").then((n) => n.r);
			let outcome;
			if (action === "diagnose") outcome = await diagnoseAndPlan(request);
			else if (action === "rollback") {
				const { readdir, readFile } = await import("node:fs/promises");
				const { doctorRoot } = await import("./paths-CSu3On3H.mjs").then((n) => n.i);
				const dir = doctorRoot(request.home) + "/transactions";
				let latest;
				try {
					latest = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort().reverse()[0];
				} catch {
					latest = void 0;
				}
				outcome = latest === void 0 ? void 0 : await rollbackTransaction(request, latest.slice(0, -5));
			} else {
				const running = profile.pid !== void 0 && profile.pid > 0;
				if (action === "confirm") outcome = incident.candidateId === void 0 ? void 0 : await confirmRepair({
					...request,
					allowLive: !running
				}, incident.candidateId);
				else outcome = await repairProfile({
					...request,
					allowLive: !running,
					autoPromote: this.state.policy.autoRepair
				});
			}
			if (outcome === void 0) return;
			incident.updatedAt = at;
			incident.evidence = [.../* @__PURE__ */ new Set([...incident.evidence, "recovery: " + outcome.phase + (outcome.message !== void 0 ? " - " + outcome.message : "")])];
			if (outcome.phase === "staged") {
				incident.phase = "awaiting-confirmation";
				if (outcome.txnId !== void 0) incident.candidateId = outcome.txnId;
			} else if (outcome.ok) incident.phase = action === "rollback" ? "rolled-back" : "recovered";
			else if (outcome.phase === "failed" || outcome.phase === "blocked" || outcome.phase === "aborted") incident.phase = "unresolved";
		} catch (error) {
			incident.updatedAt = at;
			incident.evidence = [...incident.evidence, "recovery error: " + (error instanceof Error ? error.message : String(error))];
		}
	}
	/**
	* Enter the provisioning phase and refresh the rescue capsule in the
	* background. The IPC response returns immediately with the provisioning
	* snapshot; the outcome (armed or degraded) is persisted when the capsule
	* run settles. Concurrent provision requests are coalesced.
	*/
	async startProvision() {
		if (this.provisioning) return;
		this.provisioning = true;
		this.state.phase = "provisioning";
		await this.persist();
		this.finishProvision(this.runCapsuleProvision());
	}
	async finishProvision(pending) {
		try {
			await pending;
			this.state.phase = this.state.paused ? "disabled" : "armed";
			this.state.degradedReason = void 0;
			this.state.capsuleVersion = this.version;
		} catch (error) {
			this.state.phase = "degraded";
			this.state.degradedReason = "capsule provision failed: " + (error instanceof Error ? error.message : String(error));
		} finally {
			this.provisioning = false;
			await this.persist();
		}
	}
	async runCapsuleProvision() {
		if (this.provisioner !== void 0) {
			await this.provisioner(this.paths);
			return;
		}
		const explicit = process.env.DSH_DOCTOR_REAL_DSH?.trim();
		const first = Object.values(this.state.profiles).find((profile) => profile.identity.role !== "rescue");
		const dshExecutable = explicit && explicit !== "" ? explicit : first?.identity.dshExecutable ?? this.locateDsh();
		const spec = process.env.DSH_DOCTOR_PACKAGE?.trim() || "@linxin666/dsh-doctor@" + this.version;
		const sourceHome = first?.identity.dshHome ?? resolveDshHome();
		const sourceProfile = first?.identity.name ?? "web";
		await provisionCapsule({
			paths: this.paths,
			dshExecutable,
			doctorSpec: spec,
			doctorPackageDir: process.env.DSH_DOCTOR_PACKAGE_DIR?.trim(),
			doctorVersion: this.version,
			sourceHome,
			sourceProfile,
			mirrorCredentials: process.env.DSH_DOCTOR_CREDENTIALS !== "off"
		});
	}
	async cleanupCapsuleCredentials() {
		try {
			await removeCapsuleCredentialFiles(this.paths);
		} catch {}
	}
	locateDsh() {
		try {
			return findRealDsh();
		} catch {
			return "dsh";
		}
	}
	persistQueue = Promise.resolve();
	/** Serialized persist: concurrent handle/sweep writes queue instead of racing on the temp file. */
	persist() {
		const write = () => writeJsonAtomic(join$1(this.paths.state, "supervisor.json"), this.state);
		this.persistQueue = this.persistQueue.catch(() => void 0).then(write);
		return this.persistQueue;
	}
	async sweepHeartbeats() {
		const at = this.now();
		const now = Date.parse(at);
		if (this.state.paused || !this.state.policy.fullProtection) return;
		for (const profile of Object.values(this.state.profiles)) if (profile.phase === "healthy" && profile.lastHealthyAt && now - Date.parse(profile.lastHealthyAt) > this.heartbeatTimeoutMs) {
			profile.phase = "suspected";
			openIncident(this.state, profile.identity.id, "heartbeat-timeout", "Doctor heartbeat timed out", ["last heartbeat: " + profile.lastHealthyAt], at);
		}
		await this.persist();
	}
};
async function runSupervisor() {
	const supervisor = new DoctorSupervisor();
	await supervisor.start();
	const stop = () => {
		supervisor.stop().finally(() => process.exit(0));
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}
//#endregion
//#region src/agent/service.ts
const quoteXml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const quoteExec = (value) => JSON.stringify(value);
const quoteCmd = (value) => `"${value.replaceAll('"', '""')}"`;
function servicePlan(spec, env = process.env) {
	const executable = (spec.platform === "win32" ? win32 : posix).resolve(spec.executable);
	const home = env.HOME?.trim() || homedir();
	if (spec.platform === "darwin") {
		const path = posix.join(home, "Library", "LaunchAgents", `${spec.label}.plist`);
		const args = [executable, ...spec.args].map((value) => `<string>${quoteXml(value)}</string>`).join("");
		const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${quoteXml(spec.label)}</string><key>ProgramArguments</key><array>${args}</array><key>EnvironmentVariables</key><dict><key>DSH_DOCTOR_HOME</key><string>${quoteXml(spec.doctorHome)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string></dict></plist>
`;
		const user = `gui/${process.getuid?.() ?? 0}`;
		return {
			files: [{
				path,
				content,
				mode: 384
			}],
			install: [
				"launchctl",
				"bootstrap",
				user,
				path
			],
			uninstall: [
				"launchctl",
				"bootout",
				user,
				path
			],
			restart: [
				"launchctl",
				"kickstart",
				"-k",
				`${user}/${spec.label}`
			]
		};
	}
	if (spec.platform === "linux") {
		const config = env.XDG_CONFIG_HOME?.trim() || posix.join(home, ".config");
		const path = posix.join(config, "systemd", "user", `${spec.label}.service`);
		const content = `[Unit]\nDescription=DSH Doctor Supervisor\nAfter=default.target\n\n[Service]\nType=simple\nExecStart=${[executable, ...spec.args].map(quoteExec).join(" ")}\nEnvironment=DSH_DOCTOR_HOME=${quoteExec(spec.doctorHome)}\nRestart=on-failure\nRestartSec=2\nNoNewPrivileges=true\nPrivateTmp=true\n\n[Install]\nWantedBy=default.target\n`;
		const unit = posix.basename(path);
		return {
			files: [{
				path,
				content,
				mode: 384
			}],
			install: [
				"systemctl",
				"--user",
				"enable",
				"--now",
				unit
			],
			uninstall: [
				"systemctl",
				"--user",
				"disable",
				"--now",
				unit
			],
			restart: [
				"systemctl",
				"--user",
				"restart",
				unit
			]
		};
	}
	if (spec.platform === "win32") {
		const localAppData = env.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local");
		const serviceDir = win32.join(localAppData, "DSH Doctor");
		const cmdPath = win32.join(serviceDir, "supervisor.cmd");
		const vbsPath = win32.join(serviceDir, "supervisor.vbs");
		const dshWrapper = win32.join(serviceDir, "dsh-desktop.cmd");
		const dshScript = spec.dshScript ? win32.resolve(spec.dshScript) : "";
		const realDshLine = dshScript ? `set "DSH_DOCTOR_REAL_DSH=${dshWrapper}"\r\n` : "";
		const cmdContent = `@echo off\r\nset "DSH_DOCTOR_HOME=${spec.doctorHome}"\r\n${realDshLine}set "ELECTRON_RUN_AS_NODE=1"\r\n"${executable}" ${spec.args.map(quoteCmd).join(" ")}\r\n`;
		const vbsContent = `Set WshShell = CreateObject("WScript.Shell")\r\nWshShell.Run Chr(34) & "${cmdPath}" & Chr(34), 0, False\r\n`;
		const dshWrapperContent = `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${executable}" ${quoteCmd(dshScript)} %*\r\n`;
		const task = "DSH Doctor Supervisor";
		return {
			files: [{
				path: cmdPath,
				content: cmdContent,
				mode: 384
			}, {
				path: vbsPath,
				content: vbsContent,
				mode: 384
			}, ...dshScript ? [{
				path: dshWrapper,
				content: dshWrapperContent,
				mode: 384
			}] : []],
			launch: {
				command: [executable, ...spec.args],
				env: {
					DSH_DOCTOR_HOME: spec.doctorHome,
					...dshScript ? { DSH_DOCTOR_REAL_DSH: dshWrapper } : {},
					ELECTRON_RUN_AS_NODE: "1"
				}
			},
			install: [
				"schtasks",
				"/Create",
				"/F",
				"/SC",
				"ONLOGON",
				"/TN",
				task,
				"/TR",
				`wscript.exe "${vbsPath}"`
			],
			uninstall: [
				"schtasks",
				"/Delete",
				"/F",
				"/TN",
				task
			],
			restart: [
				"schtasks",
				"/Run",
				"/TN",
				task
			]
		};
	}
	throw new Error(`doctor: unsupported service platform ${spec.platform}`);
}
async function writeServiceFiles(plan) {
	for (const file of plan.files) {
		await mkdir(file.path.includes("\\") ? win32.dirname(file.path) : posix.dirname(file.path), { recursive: true });
		await writeFile(file.path, file.content, { mode: file.mode ?? 384 });
	}
}
async function removeServiceFiles(plan) {
	for (const file of plan.files) await rm(file.path, { force: true });
}
/**
* Build a hidden, fail-closed Windows cleanup command for one explicitly
* scoped detached Doctor supervisor. An ordinary Doctor CLI has no desktop
* scope and therefore produces no cleanup command at all.
*/
function windowsDetachedSupervisorCleanup(plan) {
	if (process.platform !== "win32" || !plan.launch?.command?.[0]) return;
	const environment = process.env;
	const candidateRootValue = environment.DSH_DESKTOP_DOCTOR_CANDIDATE_ROOT?.trim();
	const cliPathValue = environment.DSH_DESKTOP_DOCTOR_CLI_PATH?.trim();
	const ownerPid = environment.DSH_DESKTOP_DOCTOR_OWNER_PID?.trim();
	const ownerStartedAt = environment.DSH_DESKTOP_DOCTOR_OWNER_STARTED_AT?.trim();
	if (!candidateRootValue || !cliPathValue || !/^\d+$/.test(ownerPid ?? "") || !/^\d+$/.test(ownerStartedAt ?? "")) return;
	let candidateRoot;
	let cliPath;
	let executable;
	try {
		candidateRoot = win32.resolve(candidateRootValue);
		cliPath = win32.resolve(cliPathValue);
		executable = win32.resolve(plan.launch.command[0]);
	} catch {
		return;
	}
	const relativeCliPath = win32.relative(candidateRoot, cliPath).replaceAll("\\", "/");
	if (!/^profiles\/[^/]+\/node_modules\/@linxin666\/dsh-doctor\/lib\/cli\.mjs$/i.test(relativeCliPath)) return;
	if (Object.isFrozen(plan.launch) || Object.isFrozen(plan.launch.command)) return;
	const scopeArgs = [
		"--dsh-desktop-candidate-root",
		candidateRoot,
		"--parent-pid",
		ownerPid,
		"--parent-started-at",
		ownerStartedAt
	];
	const hasScope = scopeArgs.every(value => plan.launch.command.includes(value));
	if (!hasScope) plan.launch.command = [...plan.launch.command, ...scopeArgs];
	const encodedExecutable = Buffer.from(executable, "utf8").toString("base64");
	const encodedCandidateRoot = Buffer.from(candidateRoot, "utf8").toString("base64");
	const encodedCliPath = Buffer.from(cliPath, "utf8").toString("base64");
	const encodedOwnerPid = Buffer.from(ownerPid, "utf8").toString("base64");
	const encodedOwnerStartedAt = Buffer.from(ownerStartedAt, "utf8").toString("base64");
	const script = [
		"$ErrorActionPreference = 'Stop'",
		`$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedExecutable}'))`,
		`$targetCli = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCliPath}'))`,
		`$candidateRoot = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedCandidateRoot}'))`,
		`$ownerPidText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedOwnerPid}'))`,
		`$ownerStartedAtText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedOwnerStartedAt}'))`,
		"try {",
		"  $target = [IO.Path]::GetFullPath($target)",
		"  $targetCli = [IO.Path]::GetFullPath($targetCli)",
		"  $candidateRoot = [IO.Path]::GetFullPath($candidateRoot)",
		"} catch { exit 0 }",
		"$ownerPid = 0",
		"if (-not [Int32]::TryParse($ownerPidText, [ref]$ownerPid) -or $ownerPid -le 0) { exit 0 }",
		"$ownerStartedAt = [Int64]0",
		"if (-not [Int64]::TryParse($ownerStartedAtText, [ref]$ownerStartedAt) -or $ownerStartedAt -lt 0) { exit 0 }",
		"$comparison = [StringComparison]::OrdinalIgnoreCase",
		"$currentPid = [Environment]::ProcessId",
		"$quotedExecutable = '\"' + $target + '\"'",
		"$cliPattern = '(?i)(^|\\s)\"?' + [regex]::Escape($targetCli) + '\"?(?=\\s|$)'",
		"$rootPattern = '(?i)(^|\\s)--dsh-desktop-candidate-root\\s+\"?' + [regex]::Escape($candidateRoot) + '\"?(?=\\s|$)'",
		"$ownerPidPattern = '(?i)(^|\\s)--parent-pid\\s+' + [regex]::Escape($ownerPidText) + '(?=\\s|$)'",
		"$ownerStartedAtPattern = '(?i)(^|\\s)--parent-started-at\\s+' + [regex]::Escape($ownerStartedAtText) + '(?=\\s|$)'",
		"$supervisorPattern = '(?i)(^|\\s)supervisor(?=\\s|$)'",
		"$matches = @(Get-CimInstance Win32_Process | Where-Object {",
		"  if ($_.ProcessId -eq $currentPid -or [string]::IsNullOrWhiteSpace($_.CommandLine)) { return $false }",
		"  $line = [string]$_.CommandLine",
		"  if (-not [regex]::IsMatch($line, $cliPattern) -or -not [regex]::IsMatch($line, $supervisorPattern)) { return $false }",
		"  if (-not [regex]::IsMatch($line, $rootPattern) -or -not [regex]::IsMatch($line, $ownerPidPattern) -or -not [regex]::IsMatch($line, $ownerStartedAtPattern)) { return $false }",
		"  $sameExecutable = $false",
		"  if (-not [string]::IsNullOrWhiteSpace($_.ExecutablePath)) {",
		"    try { $sameExecutable = [IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals([IO.Path]::GetFullPath($target), $comparison) } catch { $sameExecutable = $false }",
		"  }",
		"  if (-not $sameExecutable -and $line.StartsWith($quotedExecutable + ' ', $comparison)) { $sameExecutable = $true }",
		"  if (-not $sameExecutable) { return $false }",
		"  try {",
		"    $creationValue = $_.CreationDate",
		"    if ($creationValue -is [DateTime]) {",
		"      $createdAt = [DateTimeOffset]$creationValue.ToUniversalTime()",
		"    } elseif ($creationValue -is [DateTimeOffset]) {",
		"      $createdAt = $creationValue.ToUniversalTime()",
		"    } elseif ($creationValue -is [string]) {",
		"      $createdAt = [DateTimeOffset]([System.Management.ManagementDateTimeConverter]::ToDateTime($creationValue).ToUniversalTime())",
		"    } else { return $false }",
		"    if ($createdAt.ToUnixTimeMilliseconds() -lt $ownerStartedAt) { return $false }",
		"  } catch { return $false }",
		"  return $true",
		"})",
		"if ($matches.Count -eq 0) { Write-Output \"DSH_DOCTOR_CLEANUP_STATUS=skipped;count=0\"; exit 0 }",
		"Write-Output (\"DSH_DOCTOR_CLEANUP_STATUS=stopped;count=\" + [string]$matches.Count)",
		"foreach ($item in $matches) {",
		"  Stop-Process -Id $item.ProcessId -Force -ErrorAction Stop",
		"  for ($attempt = 0; $attempt -lt 50 -and (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue); $attempt += 1) { Start-Sleep -Milliseconds 100 }",
		"  if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) { throw \"doctor: timed out stopping stale supervisor $($item.ProcessId)\" }",
		"}"
	].join("\r\n");
	return [
		"powershell.exe",
		"-NoLogo",
		"-NoProfile",
		"-NonInteractive",
		"-ExecutionPolicy",
		"Bypass",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64")
	];
}
async function stopWindowsDetachedSupervisor(plan, run = runCommand) {
	const command = windowsDetachedSupervisorCleanup(plan);
	if (command) await run(command);
}
/**
* Idempotent service redeploy: drop any previous registration (a first
* install fails harmlessly), write the definition, bootstrap it, then restart
* it so the running process picks up the current package code.
*/
async function ensureServiceInstalled(plan, run = runCommand) {
	await run(plan.uninstall).catch(() => void 0);
	await stopWindowsDetachedSupervisor(plan, run);
	await writeServiceFiles(plan);
	if (plan.launch) {
		await startDetached(plan.launch.command, plan.launch.env);
		return;
	}
	await run(plan.install);
	await run(plan.restart).catch(() => void 0);
}
/** Unregister the service and remove its definition files (tolerates absence). */
async function removeService(plan, run = runCommand) {
	await run(plan.uninstall).catch(() => void 0);
	await stopWindowsDetachedSupervisor(plan, run);
	await removeServiceFiles(plan);
}
async function runCommand(command, timeoutMs = 3e4) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn(command[0], command.slice(1), {
			stdio: "inherit",
			shell: false,
			windowsHide: true
		});
		const timer = setTimeout(() => child.kill(), timeoutMs);
		child.once("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolvePromise() : reject(/* @__PURE__ */ new Error(`doctor: command failed (${code ?? "signal"}): ${command.join(" ")}`));
		});
		child.once("error", reject);
	});
}
async function startDetached(command, extraEnv = {}) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn(command[0], command.slice(1), {
			stdio: "ignore",
			detached: true,
			shell: false,
			windowsHide: true,
			env: {
				...process.env,
				...extraEnv
			}
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolvePromise();
		});
	});
}
//#endregion
//#region src/cli.ts
async function main(argv = process.argv.slice(2)) {
	const paths = doctorPaths();
	const command = argv[0] ?? "help";
	if (command === "supervisor") {
		await runSupervisor();
		return 0;
	}
	if (command === "launch") {
		const token = (await readFile(paths.token, "utf8")).trim();
		let autoMigrate = true;
		try {
			autoMigrate = (await callSupervisor(paths.socket, token, {
				protocol: 1,
				type: "status"
			})).snapshot?.policy?.autoMigrate ?? true;
		} catch {}
		return managedLaunch({
			argv: argv.slice(1),
			endpoint: paths.socket,
			token,
			autoMigrate
		});
	}
	if (command === "status") {
		const token = (await readFile(paths.token, "utf8")).trim();
		console.log(JSON.stringify(await callSupervisor(paths.socket, token, {
			protocol: 1,
			type: "status"
		}), null, 2));
		return 0;
	}
	if (command === "provision") {
		const desktopWrapper = join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "DSH Doctor", "dsh-desktop.cmd");
		const dsh = process.env.DSH_DOCTOR_REAL_DSH || (process.platform === "win32" && process.env.DSH_DOCTOR_DSH_SCRIPT ? desktopWrapper : "dsh");
		const version = currentPackageVersion();
		const profileName = argv[1] ?? "web";
		const mirrorCredentials = !argv.includes("--no-credentials") && process.env.DSH_DOCTOR_CREDENTIALS !== "off";
		const manifest = await provisionCapsule({
			paths,
			dshExecutable: dsh,
			doctorSpec: process.env.DSH_DOCTOR_PACKAGE || "@linxin666/dsh-doctor@" + version,
			doctorPackageDir: process.env.DSH_DOCTOR_PACKAGE_DIR,
			doctorVersion: version,
			sourceHome: resolveDshHome(),
			sourceProfile: profileName,
			mirrorCredentials
		});
		console.log(JSON.stringify(manifest, null, 2));
		return 0;
	}
	if (command === "migrate") {
		const home = resolveDshHome();
		const dshPath = process.env.DSH_DOCTOR_REAL_DSH || findRealDsh();
		const outcome = await migrateLegacyAggregate(home, argv[1] ?? "web", dshPath);
		console.log(JSON.stringify(outcome, null, 2));
		return outcome.kind === "error" ? 2 : 0;
	}
	if (command === "diagnose" || command === "repair" || command === "snapshot" || command === "rollback") {
		const home = resolveDshHome();
		if (command === "rollback") {
			const txnId = argv[1];
			if (txnId === void 0) {
				console.error("usage: dsh-doctor rollback <txnId>");
				return 2;
			}
			let profile;
			try {
				profile = await discoverRollbackProfile(home, txnId);
			} catch (error) {
				console.log(JSON.stringify({
					ok: false,
					phase: "failed",
					diagnostics: [],
					actions: [],
					manualActions: [],
					txnId,
					message: error instanceof Error ? error.message : String(error)
				}, null, 2));
				return 2;
			}
			const outcome = await rollbackTransaction({
				home,
				profile
			}, txnId);
			console.log(JSON.stringify(outcome, null, 2));
			return outcome.ok ? 0 : 2;
		}
		const dshPath = process.env.DSH_DOCTOR_REAL_DSH || findRealDsh();
		const base = {
			home,
			profile: argv[1] ?? "web",
			dshPath,
			allowLive: command !== "repair" || argv.includes("--allow-live")
		};
		const outcome = command === "snapshot" ? await snapshotProfile(base) : command === "diagnose" ? await diagnoseAndPlan(base) : await repairProfile(base);
		console.log(JSON.stringify(outcome, null, 2));
		return outcome.ok ? 0 : 2;
	}
	if (command === "service-plan" || command === "service-install" || command === "service-uninstall") {
		const plan = servicePlan({
			platform: process.platform,
			label: "com.dsh.doctor",
			executable: process.execPath,
			args: [process.argv[1], "supervisor"],
			dshScript: process.env.DSH_DOCTOR_DSH_SCRIPT,
			doctorHome: paths.root
		});
		if (command === "service-plan") console.log(JSON.stringify(plan, null, 2));
		else if (command === "service-install") await ensureServiceInstalled(plan);
		else await removeService(plan);
		return 0;
	}
	console.log("Usage: dsh-doctor <supervisor|launch|status|provision [profile] [--no-credentials]|migrate [profile]|diagnose|repair|snapshot|rollback|service-plan|service-install|service-uninstall> [args...]");
	return command === "help" || command === "--help" || command === "-h" ? 0 : 2;
}
/**
* Check if the current module is the direct CLI entry point across platforms.
* Handles Windows backslashes, drive letters, and relative/absolute paths cleanly.
*/
function isDirectCliRun(metaUrl, entryArg = process.argv[1]) {
	if (!entryArg || entryArg.trim() === "") return false;
	try {
		return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(entryArg));
	} catch {
		return metaUrl === pathToFileURL(resolve(entryArg)).href;
	}
}
if (isDirectCliRun(import.meta.url)) main().then((code) => {
	const command = process.argv[2];
	if (command === "service-install" || command === "service-uninstall") process.exit(code);
	process.exitCode = code;
}, (error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
//#endregion
export { DoctorSupervisor, isDirectCliRun, main };

//# sourceMappingURL=cli.mjs.map
