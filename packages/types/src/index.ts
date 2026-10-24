/**
 * @kinema/types — shared domain types and provider contracts.
 *
 * This package depends on nothing. Everything else may depend on it. Keeping it
 * dependency-free is what allows the API, worker, web app and local companion to
 * agree on shapes without coupling to each other.
 */

export * from "./provider.js";
export * from "./domain.js";