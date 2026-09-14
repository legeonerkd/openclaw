import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { deleteSessionEntryLifecycle } from "../config/sessions/session-accessor.js";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { createPluginDoctorStateMigrationContext } from "../infra/state-migrations.plugin-doctor-context.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

function seed(
  state: OpenClawTestState,
  layout: "external" | "default" | "legacy-root" = "external",
  pluginId = "fixture-plugin",
) {
  const sessionsDir =
    layout === "external"
      ? path.join(state.root, "external-sessions")
      : layout === "default"
        ? state.sessionsDir("main")
        : state.statePath("sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const storePath = path.join(sessionsDir, "sessions.json");
  const records = Object.fromEntries(
    ["kept", "deleted"].map((name) => {
      const sessionId = `legacy-${name}`;
      const transcript = path.join(sessionsDir, `${sessionId}.jsonl`);
      fs.writeFileSync(
        transcript,
        [
          { type: "session", version: 3, id: sessionId },
          {
            type: "message",
            id: `${name}-message`,
            parentId: null,
            message: { role: "user", content: name },
          },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      fs.writeFileSync(
        `${transcript}.${pluginId === "codex" ? "codex-app-server" : pluginId}.json`,
        JSON.stringify({
          schemaVersion: 2,
          threadId: name,
          sessionFile: transcript,
          updatedAt: "2026-01-01T00:00:00.000Z",
          pluginAppPolicyContext: { fingerprint: "policy-1", apps: {}, pluginAppIds: {} },
        }),
      );
      return [
        `agent:main:${name}`,
        { sessionId, sessionFile: path.basename(transcript), updatedAt: 20 },
      ];
    }),
  );
  fs.writeFileSync(storePath, JSON.stringify(records));
  const cfg: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
    ...(layout === "external" ? { session: { store: storePath } } : {}),
  };
  recordDeferredPluginMigrations({
    env: state.env,
    pending: [
      {
        pluginId,
        reason: "The configured plugin is not installed.",
        command:
          pluginId === "codex"
            ? "openclaw plugins install @openclaw/codex"
            : "openclaw plugins install @example/fixture-plugin",
        ...(layout === "external" ? { configPaths: [["session", "store"]] } : {}),
      },
    ],
  });
  const originals = new Map(
    fs.readdirSync(sessionsDir).map((name) => {
      const file = path.join(sessionsDir, name);
      return [file, fs.readFileSync(file)];
    }),
  );
  const scope = {
    agentId: "main",
    env: state.env,
    storePath:
      layout === "legacy-root" ? path.join(state.sessionsDir("main"), "sessions.json") : storePath,
  };
  return { cfg, storePath, originals, scope };
}

describe("session sources needed by deferred plugin migrations", () => {
  it.each(["external", "default", "legacy-root"] as const)(
    "verifies canonical import and retains %s originals until resolution without replay",
    async (layout) => {
      await withOpenClawTestState({ label: "deferred-plugin-session-source" }, async (state) => {
        const { cfg, storePath, originals, scope } = seed(state, layout);
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
          "Legacy session store requires migration",
        );
        const run = () =>
          runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const imported = await run();
        expect(imported.totals.importedEntries).toBe(2);
        expect(imported.targets.flatMap((target) => target.issues)).toEqual([
          expect.objectContaining({ code: "plugin_migration_source_retained" }),
        ]);
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();

        await upsertSessionEntryCore(
          { ...scope, sessionKey: "agent:main:kept" },
          { label: "changed after import" },
        );
        await deleteSessionEntryLifecycle({
          ...scope,
          target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
          archiveTranscript: false,
          deleteTranscriptWithoutArchive: true,
        });
        expect((await run()).totals.importedEntries).toBe(0);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        for (const [file, bytes] of originals) {
          expect(fs.readFileSync(file)).toEqual(bytes);
        }

        recordDeferredPluginMigrations({
          env: state.env,
          pending: [],
          resolvedPluginIds: ["fixture-plugin"],
        });
        const resumed = await run();
        expect(resumed.totals.importedEntries).toBe(0);
        expect(resumed.targets.flatMap((target) => target.issues)).toEqual([]);
        expect(fs.existsSync(storePath)).toBe(false);
        expect(resumed.totals.archivedTranscriptFiles).toBe(2);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label,
        ).toBe("changed after import");
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).not.toThrow();
      });
    },
  );

  it("does not admit or replay a retained source changed after its verified import", async () => {
    await withOpenClawTestState({ label: "deferred-plugin-source-conflict" }, async (state) => {
      const { cfg, storePath, scope } = seed(state);
      await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:kept" },
        { label: "current" },
      );
      fs.appendFileSync(storePath, "\n");
      const retry = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(retry.totals.importedEntries).toBe(0);
      expect(retry.targets.flatMap((target) => target.issues)).toEqual([
        expect.objectContaining({ code: "retained_plugin_source_conflict" }),
      ]);
      expect(loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.label).toBe(
        "current",
      );
      expect(() => assertSessionStoreMigrationComplete({ cfg, env: state.env })).toThrow(
        "Retained session migration source changed",
      );
      expect(fs.existsSync(storePath)).toBe(true);
    });
  });
});

describe("resumed Codex session binding migration", () => {
  function migration() {
    const contract = loadBundledPluginPublicArtifactModuleSync<{
      stateMigrations: PluginDoctorStateMigration[];
    }>({ dirName: "codex", artifactBasename: "doctor-contract-api.js" });
    const sidecars = contract.stateMigrations.find(
      (entry) => entry.id === "codex-app-server-sidecars-to-plugin-state",
    );
    if (!sidecars) {
      throw new Error("Codex sidecar migration is missing from its public Doctor contract");
    }
    return sidecars;
  }

  it.each(["before", "during"] as const)(
    "honors canonical deletion %s actual plugin migration after deferred import",
    async (timing) => {
      await withOpenClawTestState({ label: `codex-deferred-deletion-${timing}` }, async (state) => {
        const { cfg, scope, originals } = seed(state, "default", "codex");
        await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const remove = () =>
          deleteSessionEntryLifecycle({
            ...scope,
            target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
            archiveTranscript: false,
            deleteTranscriptWithoutArchive: true,
          });
        if (timing === "before") {
          expect((await remove()).deleted).toBe(true);
        }
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          config: cfg,
          env: state.env,
        });
        let deletedDuringMigration = false;
        const migrationContext: typeof context =
          timing === "before"
            ? context
            : {
                ...context,
                openPluginStateKeyedStore<T>(
                  options: Parameters<typeof context.openPluginStateKeyedStore>[0],
                ) {
                  const store = context.openPluginStateKeyedStore<T>(options);
                  return {
                    ...store,
                    async registerIfAbsent(...args: Parameters<typeof store.registerIfAbsent>) {
                      const registered = await store.registerIfAbsent(...args);
                      const binding = args[1];
                      if (
                        !deletedDuringMigration &&
                        isRecord(binding) &&
                        binding.sessionId === "legacy-deleted"
                      ) {
                        deletedDuringMigration = true;
                        expect((await remove()).deleted).toBe(true);
                      }
                      return registered;
                    },
                  };
                },
              };
        const params = {
          config: cfg,
          env: state.env,
          stateDir: state.stateDir,
          oauthDir: state.statePath("oauth"),
          context: migrationContext,
        };
        const result = await migration().migrateLegacyState(params);
        expect(result.warnings).toEqual([]);
        if (timing === "during") {
          expect(deletedDuringMigration).toBe(true);
        }
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.agentHarnessId,
        ).toBe("codex");
        const readBindings = context.readPluginStateEntriesInKeyRange;
        if (!readBindings) {
          throw new Error("Doctor context must provide read-only plugin state inspection");
        }
        const bindings = readBindings("app-server-thread-bindings", {
          prefix: "session",
          limit: 100,
        });
        expect(bindings).toContainEqual(
          expect.objectContaining({
            value: expect.objectContaining({ sessionId: "legacy-kept", state: "active" }),
          }),
        );
        expect(
          bindings.filter(
            (entry) =>
              isRecord(entry.value) &&
              entry.value.sessionId === "legacy-deleted" &&
              entry.value.state === "active",
          ),
        ).toEqual([]);
        for (const file of originals.keys()) {
          if (file.endsWith(".codex-app-server.json")) {
            expect(fs.existsSync(file)).toBe(false);
          }
        }
        expect(await migration().detectLegacyState(params)).toBeNull();
      });
    },
  );

  it.each(["default", "legacy-root"] as const)(
    "does not resurrect an imported session because an unrelated %s source is unimported",
    async (layout) => {
      await withOpenClawTestState({ label: `codex-mixed-source-${layout}` }, async (state) => {
        const { cfg, scope } = seed(state, "external", "codex");
        await runDoctorSessionSqlite({ cfg, env: state.env, allAgents: true, mode: "import" });
        const directory =
          layout === "default" ? state.sessionsDir("main") : state.statePath("sessions");
        fs.mkdirSync(directory, { recursive: true });
        const unrelatedStore = path.join(directory, "sessions.json");
        const unrelatedSource = JSON.stringify({
          "agent:main:not-imported": {
            sessionId: "not-imported",
            sessionFile: "not-imported.jsonl",
            updatedAt: 1,
          },
        });
        fs.writeFileSync(unrelatedStore, unrelatedSource);
        expect(
          (
            await deleteSessionEntryLifecycle({
              ...scope,
              target: { canonicalKey: "agent:main:deleted", storeKeys: ["agent:main:deleted"] },
              archiveTranscript: false,
              deleteTranscriptWithoutArchive: true,
            })
          ).deleted,
        ).toBe(true);
        const context = createPluginDoctorStateMigrationContext({
          pluginId: "codex",
          config: cfg,
          env: state.env,
        });
        const result = await migration().migrateLegacyState({
          config: cfg,
          env: state.env,
          stateDir: state.stateDir,
          oauthDir: state.statePath("oauth"),
          context,
        });
        expect(result.warnings).toEqual([]);
        expect(
          loadExactSessionEntry({ ...scope, sessionKey: "agent:main:deleted" }),
        ).toBeUndefined();
        expect(
          await context.readSessionIdentityEvidenceBatch?.([
            { agentId: "main", sessionId: "legacy-deleted" },
            { agentId: "main", sessionId: "not-imported" },
          ]),
        ).toEqual([
          { agentId: "main", sessionId: "legacy-deleted", state: "absent" },
          { agentId: "main", sessionId: "not-imported", state: "unknown" },
        ]);
        expect(fs.readFileSync(unrelatedStore, "utf8")).toBe(unrelatedSource);
      });
    },
  );

  it("still imports a first legacy binding when canonical state exists but its source was never imported", async () => {
    await withOpenClawTestState({ label: "codex-first-sidecar-import" }, async (state) => {
      const { cfg, scope } = seed(state, "default", "codex");
      await upsertSessionEntryCore(
        { ...scope, sessionKey: "agent:main:unrelated" },
        { sessionId: "unrelated", updatedAt: 1 },
      );
      const context = createPluginDoctorStateMigrationContext({
        pluginId: "codex",
        config: cfg,
        env: state.env,
      });
      const result = await migration().migrateLegacyState({
        config: cfg,
        env: state.env,
        stateDir: state.stateDir,
        oauthDir: state.statePath("oauth"),
        context,
      });
      expect(result.warnings).toEqual([]);
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:kept" })?.entry.agentHarnessId,
      ).toBe("codex");
      expect(
        loadExactSessionEntry({ ...scope, sessionKey: "agent:main:unrelated" })?.entry.sessionId,
      ).toBe("unrelated");
    });
  });
});
