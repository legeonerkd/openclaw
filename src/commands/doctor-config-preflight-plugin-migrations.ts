import { resolveDeferredPluginMigrationConfigPaths } from "../config/deferred-plugin-migration-config.js";
import type { ConfigSnapshotReadMeasure } from "../config/io.js";
import type { ConfigFileSnapshot } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  formatDeferredPluginMigration,
  mergeDeferredPluginMigration,
  readDeferredPluginMigrations,
  recordDeferredPluginMigrations,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
  MigrationLogger,
} from "../infra/state-migrations.types.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  inspectPluginMigrationAvailability,
  type PluginMigrationInspection,
} from "./doctor/shared/plugin-migration-availability.js";
import { readShippedPluginInstallConfigImportRecords } from "./doctor/shared/plugin-registry-migration.js";
import { shouldDeferConfiguredPluginInstallRepair } from "./doctor/shared/update-phase.js";

/** One preflight retains unavailable owners until their migration reports completion. */
export function createDoctorPluginMigrationPreparation(params: {
  enabled: boolean;
  env: () => NodeJS.ProcessEnv;
  beforePersistentEffect: () => void;
  report: (result: MigrationMessages) => void;
  recordReceipt: (receipt: LegacyStateMigrationStepReceipt) => void;
  measure: ConfigSnapshotReadMeasure;
  runWithPluginMetadataSnapshot: PluginMetadataSnapshotScopeRunner;
  doctorOnlyStateMigrations: boolean;
  log?: MigrationLogger;
}) {
  const previous = readDeferredPluginMigrations({ env: params.env() });
  const previousById = new Map(previous.map((entry) => [entry.pluginId, entry]));
  let deferred = previous;
  let prepared = false;
  const completedIds = new Set<string>();
  const reportedIds = new Set<string>();
  let statelessPluginIds = new Set<string>();
  const inspectedStatelessPluginIds = new Set<string>();
  const learn = (inspection: PluginMigrationInspection | undefined) => {
    if (!inspection) {
      return;
    }
    statelessPluginIds = new Set(inspection.statelessPluginIds);
    for (const pluginId of inspection.requiredPluginIds) {
      const pending = previousById.get(pluginId);
      if (pending) {
        previousById.set(pluginId, { ...pending, requiresStateMigration: true });
      }
    }
    for (const pluginId of inspection.inspectionRequiredPluginIds) {
      const pending = previousById.get(pluginId);
      if (pending) {
        previousById.set(pluginId, { ...pending, requiresDoctorInspection: true });
      }
    }
  };
  const retain = (pending: DeferredPluginMigration) =>
    mergeDeferredPluginMigration(previousById.get(pending.pluginId), pending);
  const remember = () => {
    for (const pending of deferred) {
      previousById.set(pending.pluginId, pending);
    }
  };
  const prepare = async (snapshot: ConfigFileSnapshot) => {
    if (!prepared && params.enabled) {
      const availability = await inspectPluginMigrationAvailability({
        cfg: snapshot.sourceConfig,
        env: params.env(),
        installRecords: readShippedPluginInstallConfigImportRecords(snapshot, {
          env: params.env(),
        }),
        retainedPluginIds: [...previousById.keys()],
        deferInstallation: shouldDeferConfiguredPluginInstallRepair(params.env()),
      });
      learn(availability);
      deferred = availability.pending.map(retain);
      remember();
      prepared = true;
    }
    return [...previousById.values()];
  };
  const reportPending = (plugin: DeferredPluginMigration) => {
    if (reportedIds.has(plugin.pluginId)) {
      return;
    }
    reportedIds.add(plugin.pluginId);
    const warning = formatDeferredPluginMigration(plugin);
    params.report({
      changes: [],
      warnings: [warning],
      warningDisposition: "recoverable",
      outcome: "deferred",
    });
    params.recordReceipt({
      id: `plugin:${plugin.pluginId}`,
      phase: "final",
      source: [{ kind: "owner", id: plugin.pluginId }],
      target: [{ kind: "owner", id: plugin.pluginId }],
      requiredness: "conditional",
      reversibility: "checkpoint-required",
      outcome: "deferred",
      changes: [],
      warnings: [warning],
    });
  };

  return {
    deferred: () => deferred,
    hasPending: () => previousById.size > 0,
    prepare,
    snapshotOptions: () => ({
      preparePluginMigrations: !prepared && params.enabled ? prepare : undefined,
      deferredPluginMigrations: [...previousById.values()],
    }),
    async migrate(config: OpenClawConfig) {
      const { autoMigrateLegacyPluginDoctorState } =
        await import("../infra/state-migrations.plugin-doctor.js");
      params.report(
        await params.measure("plugin-doctor-migrations", () =>
          params.runWithPluginMetadataSnapshot({ config }, () =>
            autoMigrateLegacyPluginDoctorState({
              config,
              env: params.env(),
              log: params.log,
              ...(params.doctorOnlyStateMigrations ? { doctorOnlyStateMigrations: true } : {}),
            }),
          ),
        ),
      );
    },
    converged(
      pending: readonly DeferredPluginMigration[],
      snapshot: ConfigFileSnapshot,
      metadata: PluginMetadataSnapshot | undefined,
      inspection?: PluginMigrationInspection,
    ) {
      learn(inspection);
      deferred = pending.map((plugin) =>
        retain(
          Object.assign(
            resolveDeferredPluginMigrationConfigPaths({
              config: snapshot.sourceConfigBeforeMigrations ?? snapshot.sourceConfig,
              pluginId: plugin.pluginId,
              compatibilityMigrationPaths: metadata?.plugins.find(
                (record) => record.id === plugin.pluginId,
              )?.configContracts?.compatibilityMigrationPaths,
            }),
            plugin,
          ),
        ),
      );
      remember();
      params.beforePersistentEffect();
      recordDeferredPluginMigrations({ env: params.env(), pending: [...previousById.values()] });
      for (const plugin of deferred) {
        reportPending(plugin);
      }
    },
    observe(result: MigrationMessages) {
      for (const pluginId of result.requiredPluginIds ?? []) {
        const pending = previousById.get(pluginId);
        if (pending) {
          previousById.set(pluginId, { ...pending, requiresStateMigration: true });
        }
      }
      for (const pluginId of result.statelessPluginIds ?? []) {
        inspectedStatelessPluginIds.add(pluginId);
      }
      for (const pluginId of result.completedPluginIds ?? []) {
        completedIds.add(pluginId);
      }
    },
    complete() {
      if (!params.enabled) {
        return false;
      }
      const unavailableIds = new Set(deferred.map((plugin) => plugin.pluginId));
      const resolvedPluginIds = [...previousById.values()]
        .filter(
          (plugin) =>
            completedIds.has(plugin.pluginId) ||
            (!plugin.requiresStateMigration &&
              !unavailableIds.has(plugin.pluginId) &&
              (inspectedStatelessPluginIds.has(plugin.pluginId) ||
                (!plugin.requiresDoctorInspection && statelessPluginIds.has(plugin.pluginId)))),
        )
        .map((plugin) => plugin.pluginId);
      const resolvedIds = new Set(resolvedPluginIds);
      const pending = [...previousById.values()]
        .filter((plugin) => !resolvedIds.has(plugin.pluginId))
        .map((plugin) =>
          unavailableIds.has(plugin.pluginId)
            ? plugin
            : Object.assign(plugin, {
                reason: "The plugin has not reported completion of its retained state migration.",
              }),
        );
      if (resolvedPluginIds.length === 0 && pending.length === 0) {
        return false;
      }
      params.beforePersistentEffect();
      recordDeferredPluginMigrations({ env: params.env(), pending, resolvedPluginIds });
      for (const pluginId of resolvedPluginIds) {
        previousById.delete(pluginId);
      }
      for (const plugin of pending) {
        previousById.set(plugin.pluginId, plugin);
        reportPending(plugin);
      }
      return resolvedPluginIds.length > 0;
    },
  };
}
