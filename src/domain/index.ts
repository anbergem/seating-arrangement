/**
 * Barrel export for the domain layer (blueprint B4). Application code should
 * import from `src/domain`, not from the individual files, so the internal
 * module layout can change without touching every caller.
 */

export * from "./errors";
export * from "./customer";
export * from "./job";
export * from "./operation";
