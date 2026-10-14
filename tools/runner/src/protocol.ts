/** The runner's own version, which `/health` reports. */
export const VERSION = "0.1.0";

/**
 * The version of what Kelpie and the runner say to each other. It changes when a request or an answer
 * changes shape, and Kelpie refuses a runner on another one.
 */
export const PROTOCOL = 1;
