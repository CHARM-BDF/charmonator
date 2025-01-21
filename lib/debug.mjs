// debug.mjs

export let DEBUG = false;

export function debug(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

export function enable_debug() {
  DEBUG = true;
  console.log("Debug mode enabled");
}

export function disable_debug() {
  DEBUG = false;
  console.log("Debug mode disabled");
}
