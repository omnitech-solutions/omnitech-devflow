/**
 * Test doubles, exported separately from the main entry point.
 *
 * A consumer testing against DevFlow needs these; a consumer running DevFlow does not, and
 * shipping them from the main export would put test code in every production bundle.
 */
export * from './ports/__fakes__/index.js';
