import { existsSync, readFileSync, writeFileSync } from 'fs';

const DB_PATH = process.env.SWS_DB || './sws_store.json';
let cache = null;

function load() {
  if (cache) return;
  if (existsSync(DB_PATH)) {
    try { cache = JSON.parse(readFileSync(DB_PATH, 'utf8')); }
    catch { cache = {}; }
  } else {
    cache = {};
  }
}

function save() {
  if (!cache) return;
  writeFileSync(DB_PATH, JSON.stringify(cache, null, 2));
}

export function getValue(key, def = '') {
  load();
  return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : def;
}

export function setValue(key, val) {
  load();
  cache[key] = val;
  save();
}
